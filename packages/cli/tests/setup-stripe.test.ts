import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerSetupCommand, STRIPE_SETUP_MOVED } from "../src/commands/setup-stripe";
import { setLoggerOptions } from "../src/lib/logger";

/**
 * Stripe is connected from the dashboard. `setup stripe` must point there, exit 1, and never
 * touch the network: the old flow created a webhook on the brand's Stripe account that pointed
 * at a URL the API does not serve.
 */
describe("affitor setup stripe", () => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.exitCode = undefined;
    setLoggerOptions({ json: false });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function run(args: string[]): Promise<string[]> {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command().option("--json", "", false);
    registerSetupCommand(program);
    await program.parseAsync(["node", "affitor", ...args]);
    return stdout.mock.calls.map((call) => call.join(" "));
  }

  it("--json: prints stripe_setup_moved and exits 1 without a network call", async () => {
    const out = await run(["--json", "setup", "stripe"]);
    expect(out).toEqual([JSON.stringify({ error: "stripe_setup_moved", message: STRIPE_SETUP_MOVED }, null, 2)]);
    expect(process.exitCode).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("old flags are accepted and still get the directions", async () => {
    await run(["setup", "stripe", "--stripe-secret-key", "sk_test_x", "--stripe-client-id", "ca_x"]);
    expect(process.exitCode).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
