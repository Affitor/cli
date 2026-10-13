import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatus } from "../src/commands/status";
import { runTest } from "../src/commands/test";
import type { CLIFlags } from "../src/types";

/**
 * QA-33: a brand whose program was created in the dashboard has its API key but no
 * `.affitor/config.json` (only `init` writes one, and `init` creates a NEW program). The API
 * finds the program from the key alone, so `status` and `test` run with `--api-key` or
 * AFFITOR_API_KEY and no config, and show the program's domain from the API.
 */

const API_URL = "http://key-only.test.local";
const flags: CLIFlags = { json: false, noInteractive: true, autoConfirm: true, quiet: false, apiUrl: API_URL, verbose: false };

const STATUS = {
  program_id: 1189,
  name: "QA Test Program",
  domain: "example.com",
  dns_verified: false,
  stripe_connected: false,
  stripe_charges_enabled: false,
  recent_events: { clicks_24h: 2, leads_24h: 1, sales_24h: 0 },
  active_partners: 1,
  pending_commissions: 0,
};

function respond(data: unknown) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data }) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("status and test with a key and no project config", () => {
  let dir: string;
  let cwd: string;
  let envKey: string | undefined;
  let out: string[];

  beforeEach(() => {
    cwd = process.cwd();
    envKey = process.env.AFFITOR_API_KEY;
    delete process.env.AFFITOR_API_KEY;
    dir = mkdtempSync(join(tmpdir(), "affitor-key-only-"));
    process.chdir(dir);
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => (out.push(String(s)), true)) as never);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    if (envKey === undefined) delete process.env.AFFITOR_API_KEY;
    else process.env.AFFITOR_API_KEY = envKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("status reads the program named by AFFITOR_API_KEY and shows its domain", async () => {
    process.env.AFFITOR_API_KEY = "aff_env_key";
    const fetchMock = respond(STATUS);

    await runStatus(flags);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe(`${API_URL}/api/v1/cli/status`);
    expect(init.headers.Authorization).toBe("Bearer aff_env_key");
    const printed = out.join("\n");
    expect(printed).toContain("example.com");
    expect(printed).not.toContain("undefined");
  });

  it("test sends the event for the program named by --api-key", async () => {
    const fetchMock = respond({ received: true, event_id: 7, attributed: false });

    await runTest("click", { ...flags, apiKey: "aff_flag_key" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe(`${API_URL}/api/v1/cli/test-event`);
    expect(init.headers.Authorization).toBe("Bearer aff_flag_key");
  });

  it("with neither config nor key, status says how to use an existing program", async () => {
    respond(STATUS);

    await expect(runStatus(flags)).rejects.toThrow("exit:1");

    expect(out.join("\n")).toContain("AFFITOR_API_KEY");
  });
});
