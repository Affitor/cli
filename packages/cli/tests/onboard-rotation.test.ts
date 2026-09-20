import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnboard } from "../src/commands/onboard";
import { setLoggerOptions } from "../src/lib/logger";
import type { CLIFlags } from "../src/types";

/**
 * `affitor onboard --json` is what a brand's agent runs. When the program key is
 * past its replacement deadline every call answers 401, so the run must say so
 * in the JSON an agent parses — and stop polling, because no gate will ever pass
 * until a new key is in place. A 401 from any other cause keeps its old
 * behaviour: keep polling, report `integration_verified: false`.
 */

const ROTATION_401 = {
  error: {
    code: "api_key_rotation_required",
    message: "This API key was retired on 2026-10-03.",
    hint: "Create a new key in Affitor → Settings → API Key.",
  },
};

const CHAIN_OK = {
  data: {
    type: "chain",
    verdict: { click: "attributed", lead: "attributed", sale: "pending" },
    attributed: false,
  },
};

const NOT_READY = {
  data: {
    integration_verified: false,
    gates: { live: { status: "fail", next_action: "Send a sale" } },
    blocker: "live",
  },
};

const API_URL = "http://test.local";

const flags: CLIFlags = {
  json: true,
  noInteractive: true,
  autoConfirm: true,
  quiet: false,
  apiUrl: API_URL,
  verbose: false,
};

/** Answer the chain POST and the readiness GET separately, and record the calls. */
function stubApi(chain: { status: number; body: unknown }, readiness: { status: number; body: unknown }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const r = url.includes("/readiness") ? readiness : chain;
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: () => null },
        json: async () => r.body,
      };
    }),
  );
  return calls;
}

const readinessCalls = (calls: string[]) => calls.filter((u) => u.includes("/readiness")).length;

describe("onboard --json and a retired API key", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    // An empty project: no framework and no payment provider are detected, so
    // onboard prints nothing to edit and goes straight to the verify loop.
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "affitor-onboard-"));
    process.chdir(dir);
    setLoggerOptions({ json: true });
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    setLoggerOptions({ json: false });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Run onboard and parse the single JSON object it writes to stdout. */
  async function onboardJson(): Promise<Record<string, unknown>> {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    await runOnboard({ apiKey: "key_test" }, flags);
    expect(stdout).toHaveBeenCalledTimes(1);
    return JSON.parse(stdout.mock.calls[0][0] as string) as Record<string, unknown>;
  }

  it("reports the retired key from the chain call and stops polling", async () => {
    const calls = stubApi({ status: 401, body: ROTATION_401 }, { status: 401, body: ROTATION_401 });

    const out = await onboardJson();

    expect(out.integration_verified).toBe(false);
    expect(out.error).toMatchObject({ code: "api_key_rotation_required" });
    const message = (out.error as { message: string }).message;
    expect(message).toContain(ROTATION_401.error.message);
    expect(message).toContain(ROTATION_401.error.hint);
    expect(readinessCalls(calls)).toBe(0);
  });

  it("reports the retired key from the readiness call and stops polling", async () => {
    const calls = stubApi({ status: 200, body: CHAIN_OK }, { status: 401, body: ROTATION_401 });

    const out = await onboardJson();

    expect(out.integration_verified).toBe(false);
    expect(out.error).toMatchObject({ code: "api_key_rotation_required" });
    const message = (out.error as { message: string }).message;
    expect(message).toContain(ROTATION_401.error.message);
    expect(message).toContain(ROTATION_401.error.hint);
    // One attempt, not the full poll: the key cannot become valid by waiting.
    expect(readinessCalls(calls)).toBe(1);
  });

  it("leaves any other 401 on its old path: keep polling, no rotation error", async () => {
    vi.useFakeTimers();
    const calls = stubApi({ status: 200, body: CHAIN_OK }, { status: 401, body: { error: "Invalid token" } });
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    const run = runOnboard({ apiKey: "key_test" }, flags);
    await vi.runAllTimersAsync();
    await run;

    const out = JSON.parse(stdout.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(out.integration_verified).toBe(false);
    expect(out.error).toBeUndefined();
    expect(readinessCalls(calls)).toBeGreaterThan(1);
  });

  it("returns the gate verdict untouched when the key is fine", async () => {
    stubApi({ status: 200, body: CHAIN_OK }, { status: 200, body: NOT_READY });
    vi.useFakeTimers();
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

    const run = runOnboard({ apiKey: "key_test" }, flags);
    await vi.runAllTimersAsync();
    await run;

    const out = JSON.parse(stdout.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(out.error).toBeUndefined();
    expect(out.blocker).toBe("live");
    expect(out.next_action).toBe("Send a sale");
  });
});
