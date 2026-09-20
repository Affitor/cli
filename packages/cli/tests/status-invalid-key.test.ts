import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatus } from "../src/commands/status";
import { setLoggerOptions } from "../src/lib/logger";
import type { CLIFlags } from "../src/types";

/**
 * What `affitor status` tells the caller when the API key is refused.
 *
 * Product rules the message has to respect:
 *   - `init` creates a new program, so it is never the way back to a working key for the
 *     program this directory already points at.
 *   - only a workspace owner of that program can regenerate its key.
 *   - the new key has to replace the one this command actually reads. `--api-key` wins over
 *     AFFITOR_API_KEY, so naming the environment alone would send the same refused key again.
 *   - and it has to name that place the way the place spells it: `.affitor/.env` holds
 *     `AFFITOR_API_KEY=`, so advice about `api_key` there would be edited into a line the
 *     parser never reads, leaving the refused key in the file.
 *
 * The retired-key branch (`api_key_rotation_required`) passes the API's own message and hint
 * through, and both halves are asserted here.
 */

const API_URL = "http://status.test.local";

const baseFlags: CLIFlags = {
  json: false,
  noInteractive: true,
  autoConfirm: true,
  quiet: false,
  apiUrl: API_URL,
  verbose: false,
};

const PROGRAM_ID = "42";

/** Stub every request with a 401 and hand back the mock, so a test can read what was sent. */
function respond401(body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The Authorization header of the first request the stub received. */
function sentKey(fetchMock: ReturnType<typeof respond401>): string | undefined {
  const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.Authorization;
}

/** Run status against a stubbed 401 and return everything it printed to stderr. */
async function statusStderr(flags: CLIFlags): Promise<string> {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(runStatus(flags)).rejects.toThrow("exit:1");
  return stderr.mock.calls.map((call) => call.join(" ")).join("\n");
}

describe("affitor status: what a refused key is told to do", () => {
  let dir: string;
  let cwd: string;
  let originalEnvKey: string | undefined;

  beforeEach(() => {
    cwd = process.cwd();
    originalEnvKey = process.env.AFFITOR_API_KEY;
    delete process.env.AFFITOR_API_KEY;

    dir = mkdtempSync(join(tmpdir(), "affitor-status-"));
    mkdirSync(join(dir, ".affitor"));
    writeFileSync(
      join(dir, ".affitor", "config.json"),
      JSON.stringify({
        version: 2,
        program_id: PROGRAM_ID,
        domain: "example.test",
        tracking_subdomain: "t.example.test",
        commission: { type: "percent", rate: 10 },
        cookie: { name: "affitor_ref", duration_days: 30 },
        ref_param: "ref",
        api_url: API_URL,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    process.chdir(dir);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    if (originalEnvKey === undefined) delete process.env.AFFITOR_API_KEY;
    else process.env.AFFITOR_API_KEY = originalEnvKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names the program, the owner and the Regenerate button", async () => {
    respond401({ data: null, error: { status: 401, message: "Invalid API key." } });

    const out = await statusStderr({ ...baseFlags, apiKey: "aff_test_key" });

    expect(out).toContain(`workspace owner of program ${PROGRAM_ID}`);
    expect(out).toContain("Affitor → Settings → API Key");
    expect(out).toContain("Regenerate");
    expect(out).not.toContain("affitor init");
  });

  it("points at the `--api-key` option when that is where the key came from", async () => {
    respond401({ data: null, error: { status: 401, message: "Invalid API key." } });

    // The flag beats the environment, so updating AFFITOR_API_KEY here would change nothing.
    process.env.AFFITOR_API_KEY = "aff_env_key";
    const out = await statusStderr({ ...baseFlags, apiKey: "aff_flag_key" });

    expect(out).toContain("replace the key in the `--api-key` option you passed");
    expect(out).not.toContain("AFFITOR_API_KEY");
  });

  it("points at AFFITOR_API_KEY when the key came from the environment", async () => {
    respond401({ data: null, error: { status: 401, message: "Invalid API key." } });

    process.env.AFFITOR_API_KEY = "aff_env_key";
    const out = await statusStderr({ ...baseFlags });

    expect(out).toContain("replace the key in AFFITOR_API_KEY in this environment");
    expect(out).not.toContain("--api-key");
  });

  it("forwards the API's own sentence on the --json channel", async () => {
    // In `--json` mode the printed advice is suppressed, so what an agent reads is whatever
    // the API said. Written out here rather than imported: this is the CMS 401 text.
    const fromApi =
      "Invalid API key. To get a working key for the program you already have, ask a workspace " +
      "owner of that program to open Affitor → Settings → API Key and click Regenerate, then " +
      "replace the key you are sending with the new one.";
    respond401({ data: null, error: { status: 401, message: fromApi } });

    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    setLoggerOptions({ json: true });
    try {
      await expect(runStatus({ ...baseFlags, json: true, apiKey: "aff_test_key" })).rejects.toThrow(
        "exit:1",
      );
    } finally {
      setLoggerOptions({ json: false });
    }

    const printed = stdout.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(JSON.parse(printed)).toEqual({ error: fromApi, status: 401 });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("names AFFITOR_API_KEY in .affitor/.env when that file holds the key", async () => {
    // Written the way the CLI writes it: the file holds AFFITOR_API_KEY, not `api_key`.
    writeFileSync(
      join(dir, ".affitor", ".env"),
      "# Affitor secrets — auto-generated, DO NOT commit\n" +
        `AFFITOR_API_KEY=aff_from_dotenv\nAFFITOR_PROGRAM_ID=${PROGRAM_ID}\n`,
    );
    const first = respond401({ data: null, error: { status: 401, message: "Invalid API key." } });

    // No flag, no environment override, so the file is what the request carries.
    const out = await statusStderr({ ...baseFlags });

    expect(sentKey(first)).toBe("Bearer aff_from_dotenv");
    expect(out).toContain("replace the key in AFFITOR_API_KEY in .affitor/.env");
    expect(out).not.toContain("api_key");
    expect(out).not.toContain("in this environment");

    // Editing the line the advice names is what changes the key on the wire.
    writeFileSync(
      join(dir, ".affitor", ".env"),
      "# Affitor secrets — auto-generated, DO NOT commit\n" +
        `AFFITOR_API_KEY=aff_replaced\nAFFITOR_PROGRAM_ID=${PROGRAM_ID}\n`,
    );
    const second = respond401({ data: null, error: { status: 401, message: "Invalid API key." } });
    await statusStderr({ ...baseFlags });

    expect(sentKey(second)).toBe("Bearer aff_replaced");
  });

  it("names AFFITOR_API_KEY, never `api_key`, when no key is set anywhere", async () => {
    respond401({ data: null, error: { status: 401, message: "Invalid API key." } });

    const out = await statusStderr({ ...baseFlags });

    expect(out).toContain("AFFITOR_API_KEY");
    expect(out).not.toContain("api_key");
  });

  it("still prints both the message and the hint of a retired key", async () => {
    respond401({
      error: {
        code: "api_key_rotation_required",
        message: "This API key was retired on 2026-10-03.",
        hint: "Create a new key in Affitor → Settings → API Key.",
      },
    });

    const out = await statusStderr({ ...baseFlags, apiKey: "aff_test_key" });

    expect(out).toContain("This API key was retired on 2026-10-03.");
    expect(out).toContain("Create a new key in Affitor → Settings → API Key.");
    expect(out).not.toContain("affitor init");
  });
});
