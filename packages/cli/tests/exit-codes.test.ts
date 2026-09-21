import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerWhoamiCommand } from "../src/commands/whoami";
import { runOnboard } from "../src/commands/onboard";
import { setLoggerOptions } from "../src/lib/logger";
import type { CLIFlags } from "../src/types";

// The text-mode wizard installs packages; these tests are only about the exit code.
vi.mock("../src/lib/wizard", () => ({ runInstallWizard: vi.fn(async () => {}) }));

/**
 * An agent reads the exit code before it parses stdout. A command that failed
 * must not exit 0, and fixing that must not change a byte of what it prints.
 */

const API_URL = "http://test.local";

const flags = (json: boolean): CLIFlags => ({
  json,
  noInteractive: true,
  autoConfirm: true,
  quiet: false,
  apiUrl: API_URL,
  verbose: false,
});

const CHAIN_OK = {
  data: {
    type: "chain",
    verdict: { click: "attributed", lead: "attributed", sale: "attributed" },
    attributed: true,
  },
};

const ROTATION_401 = {
  error: {
    code: "api_key_rotation_required",
    message: "This API key was retired on 2026-10-03.",
    hint: "Create a new key in Affitor → Settings → API Key.",
  },
};

const gates = (over: Record<string, { status: string; next_action?: string }>) => ({
  profile: { status: "pass" },
  economics: { status: "pass" },
  payout: { status: "fail", mode: "stripe", next_action: "surface_stripe_connect_url" },
  tracking: { status: "pass" },
  live: { status: "pass" },
  ...over,
});

const VERIFIED = {
  data: { program_id: 42, integration_verified: true, blocker: null, gates: gates({}) },
};

const LIVE_FAILS = {
  data: {
    program_id: 42,
    integration_verified: false,
    blocker: "live",
    gates: gates({ live: { status: "fail", next_action: "run_synthetic_sale_chain" } }),
  },
};

const TRACKING_IN_FLIGHT = {
  data: {
    program_id: 42,
    integration_verified: false,
    blocker: "tracking",
    gates: gates({ tracking: { status: "unknown" } }),
  },
};

function stubApi(chain: { status: number; body: unknown }, readiness: { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const r = url.includes("/readiness") ? readiness : chain;
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: () => null },
        json: async () => r.body,
      };
    }),
  );
}

const pretty = (data: unknown) => JSON.stringify(data, null, 2);

describe("exit codes an agent can trust", () => {
  let cwd: string;
  let dir: string;
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    cwd = process.cwd();
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "affitor-home-"));
    process.env.HOME = home;
    // An empty project: nothing detected, so onboard goes straight to verify.
    dir = mkdtempSync(join(tmpdir(), "affitor-exit-"));
    process.chdir(dir);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    process.chdir(cwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    setLoggerOptions({ json: false });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("whoami --json", () => {
    async function whoami(): Promise<string[]> {
      const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = new Command().option("--json", "", false);
      registerWhoamiCommand(program);
      await program.parseAsync(["node", "affitor", "whoami", "--json"]);
      return stdout.mock.calls.map((call) => call.join(" "));
    }

    it("not logged in: prints the same JSON and exits 1, like the text mode", async () => {
      const out = await whoami();

      expect(out).toEqual([pretty({ logged_in: false })]);
      expect(process.exitCode).toBe(1);
    });

    it("logged in: exits 0", async () => {
      mkdirSync(join(home, ".affitor"));
      writeFileSync(
        join(home, ".affitor", "credentials.json"),
        JSON.stringify({ token: "jwt_test", email: "brand@example.test", expires_at: "2099-01-01T00:00:00.000Z" }),
      );

      const out = await whoami();

      expect(JSON.parse(out[0])).toMatchObject({ logged_in: true, email: "brand@example.test" });
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("onboard", () => {
    async function onboard(json: boolean): Promise<string[]> {
      setLoggerOptions({ json });
      vi.useFakeTimers();
      const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const run = runOnboard({ apiKey: "key_test" }, flags(json));
      await vi.runAllTimersAsync();
      await run;
      return stdout.mock.calls.map((call) => call.join(" "));
    }

    const JSON_STEPS = [
      { step: "detect", status: "ok", detail: "framework=unknown, provider=unknown" },
      { step: "browser_tracking", status: "skipped", detail: "json mode" },
      { step: "server_sale", status: "manual", detail: "provider=unknown: printed recipe" },
      { step: "env_key", status: "manual", detail: ".env: json mode (no auto-edit)" },
    ];

    it("--json, a gate fails: same summary on stdout, exits 1", async () => {
      stubApi({ status: 200, body: CHAIN_OK }, { status: 200, body: LIVE_FAILS });

      const out = await onboard(true);

      expect(out).toEqual([
        pretty({
          program_id: 42,
          steps: JSON_STEPS,
          integration_verified: false,
          blocker: "live",
          next_action: "run_synthetic_sale_chain",
        }),
      ]);
      expect(process.exitCode).toBe(1);
    });

    it("--json, the API retired the key: exits 1", async () => {
      stubApi({ status: 401, body: ROTATION_401 }, { status: 401, body: ROTATION_401 });

      const out = await onboard(true);

      expect(JSON.parse(out[0])).toMatchObject({
        integration_verified: false,
        error: { code: "api_key_rotation_required" },
      });
      expect(process.exitCode).toBe(1);
    });

    it("--json, readiness never answers: exits 1", async () => {
      stubApi({ status: 200, body: CHAIN_OK }, { status: 503, body: { error: "unavailable" } });

      const out = await onboard(true);

      expect(out).toEqual([pretty({ program_id: null, steps: JSON_STEPS, integration_verified: false })]);
      expect(process.exitCode).toBe(1);
    });

    it("--json, verified: exits 0", async () => {
      stubApi({ status: 200, body: CHAIN_OK }, { status: 200, body: VERIFIED });

      const out = await onboard(true);

      expect(out).toEqual([pretty({ program_id: 42, steps: JSON_STEPS, integration_verified: true })]);
      expect(process.exitCode).toBeUndefined();
    });

    it("--json, a gate is still unknown and none fails: pending, exit code left at 0", async () => {
      stubApi({ status: 200, body: CHAIN_OK }, { status: 200, body: TRACKING_IN_FLIGHT });

      const out = await onboard(true);

      expect(JSON.parse(out[0])).toMatchObject({ integration_verified: false, blocker: "tracking" });
      expect(process.exitCode).toBeUndefined();
    });

    it("text mode, a gate fails: exits 1", async () => {
      stubApi({ status: 200, body: CHAIN_OK }, { status: 200, body: LIVE_FAILS });

      const out = (await onboard(false)).join("\n");

      expect(out).toContain("Not verified yet.");
      expect(process.exitCode).toBe(1);
    });

    it("text mode, verified: exits 0", async () => {
      stubApi({ status: 200, body: CHAIN_OK }, { status: 200, body: VERIFIED });

      const out = (await onboard(false)).join("\n");

      expect(out).toContain("Integration verified");
      expect(process.exitCode).toBeUndefined();
    });
  });
});
