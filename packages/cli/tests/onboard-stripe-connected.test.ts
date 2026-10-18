import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const confirmAction = vi.fn<(message: string) => Promise<boolean>>();
vi.mock("../src/lib/prompts.js", () => ({ confirmAction: (m: string) => confirmAction(m) }));

// runOnboard's collaborators: the wizard (records what it was told) and the API (status as given).
const wizardCalls: Array<Record<string, unknown>> = [];
vi.mock("../src/lib/wizard.js", () => ({
  runInstallWizard: async (opts: Record<string, unknown>) => {
    wizardCalls.push(opts);
  },
}));
const apiState: { status: unknown } = { status: {} };
vi.mock("../src/lib/api-client.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/api-client")>();
  class FakeAPI {
    async getStatus() {
      if (apiState.status instanceof Error) throw apiState.status;
      return apiState.status;
    }
    async runVerificationChain() {
      return {};
    }
    async getReadiness() {
      return { integration_verified: true };
    }
  }
  return { ...real, AffitorAPI: FakeAPI };
});

const { callsTrackSale, readStripeAccountBound, runOnboard, wireServerSale } = await import("../src/commands/onboard");

/**
 * Report 2026-10-17 (onboard trackSale double count): with the program's Stripe connected,
 * Affitor already records each payment, so `affitor onboard` must not add a trackSale call
 * (a subscription's first payment was recorded twice). Unknown connection: ask, and with
 * nobody to ask, change nothing.
 */

const WEBHOOK = `import Fastify from 'fastify';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_KEY!);
const app = Fastify();

app.post('/webhooks/stripe', async (req, reply) => {
  const sig = req.headers['stripe-signature'] as string;
  const event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      await fulfill(session);
      break;
    }
  }

  reply.send({ received: true });
});
`;
const HOOK_FILE = join("src", "routes", "webhooks.ts");

const dirs: string[] = [];
function project(webhook = WEBHOOK): string {
  const dir = mkdtempSync(join(tmpdir(), "affitor-onboard-"));
  const full = join(dir, HOOK_FILE);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, webhook);
  dirs.push(dir);
  return dir;
}
const webhookOf = (dir: string) => readFileSync(join(dir, HOOK_FILE), "utf8");

function wire(cwd: string, over: Partial<Parameters<typeof wireServerSale>[0]> = {}) {
  return wireServerSale({
    cwd,
    framework: "fastify",
    provider: "stripe",
    interactive: false,
    autoConfirm: true,
    json: false,
    ...over,
  });
}

beforeEach(() => {
  vi.stubEnv("AFFITOR_API_KEY", undefined);
  confirmAction.mockReset();
  wizardCalls.length = 0;
  apiState.status = {};
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("wireServerSale — Stripe connected in Affitor", () => {
  it("adds no trackSale and leaves the webhook unchanged, even with --yes", async () => {
    const dir = project();
    const step = await wire(dir, { stripeAccountBound: true });
    expect(step).toMatchObject({ step: "server_sale", status: "skipped" });
    expect(step.detail).toContain("stripe connected");
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("points out a webhook that already calls trackSale (it counts each payment twice)", async () => {
    const wired = WEBHOOK.replace("await fulfill(session);", "await affitor.trackSale({ customerExternalId: 'u', amount: 1, invoiceId: session.id });");
    const dir = project(wired);
    const step = await wire(dir, { stripeAccountBound: true });
    expect(step.status).toBe("skipped");
    expect(step.detail).toContain("already calls trackSale");
    expect(webhookOf(dir)).toBe(wired);
  });
});

describe("wireServerSale — Stripe not connected", () => {
  it("a false current binding cannot rule out delayed/shared-account events (--yes leaves the webhook alone)", async () => {
    const dir = project();
    const step = await wire(dir, { stripeAccountBound: false });
    expect(step.status).toBe("manual");
    expect(webhookOf(dir)).toBe(WEBHOOK);
  });
});

describe("wireServerSale — connection unknown", () => {
  it("with --yes (nobody to ask): webhook unchanged, reported as manual", async () => {
    const dir = project();
    const step = await wire(dir, { stripeAccountBound: undefined });
    expect(step.status).toBe("manual");
    expect(step.detail).toContain("unknown");
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("in --json mode: webhook unchanged, nobody asked", async () => {
    const dir = project();
    const step = await wire(dir, { stripeAccountBound: undefined, json: true, autoConfirm: false, interactive: true });
    expect(step.status).toBe("manual");
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("interactive, answer yes (connected): no trackSale added", async () => {
    const dir = project();
    confirmAction.mockResolvedValueOnce(true);
    const step = await wire(dir, { stripeAccountBound: undefined, interactive: true, autoConfirm: false });
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(confirmAction.mock.calls[0][0]).toContain("Could Stripe Connect still report sales");
    expect(confirmAction.mock.calls[0][0]).toContain("delayed events after disconnect");
    expect(step.status).toBe("skipped");
    expect(webhookOf(dir)).toBe(WEBHOOK);
  });

  it("interactive, answer no: shows the diff and adds the call once confirmed", async () => {
    const dir = project();
    confirmAction.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const step = await wire(dir, { stripeAccountBound: undefined, interactive: true, autoConfirm: false });
    expect(confirmAction).toHaveBeenCalledTimes(2);
    expect(step.status).toBe("ok");
    expect(webhookOf(dir)).toContain("await affitor.trackSale({");
  });
});

describe("readStripeAccountBound", () => {
  const api = (status: unknown) => ({ getStatus: async () => status as never });

  it("reads stripe_account_bound from GET /v1/cli/status", async () => {
    expect(await readStripeAccountBound(api({ stripe_account_bound: true, stripe_connected: false }))).toBe(true);
    expect(await readStripeAccountBound(api({ stripe_account_bound: false }))).toBeUndefined();
  });

  it("an older CMS that only sends stripe_connected is unknown, never trusted (it meant Server API mode once)", async () => {
    expect(await readStripeAccountBound(api({ stripe_connected: true }))).toBeUndefined();
    expect(await readStripeAccountBound(api({ stripe_connected: false }))).toBeUndefined();
  });

  it("is undefined when the call fails", async () => {
    expect(
      await readStripeAccountBound({
        getStatus: async () => {
          throw new Error("network");
        },
      }),
    ).toBeUndefined();
  });
});

describe("callsTrackSale", () => {
  it("finds a real call, not a comment", () => {
    expect(callsTrackSale("await affitor.trackSale({ invoiceId })")).toBe(true);
    expect(callsTrackSale("// trackSale is documented elsewhere")).toBe(false);
    expect(callsTrackSale("  // await affitor.trackSale({})")).toBe(false);
    expect(callsTrackSale(" * see trackSale(input)")).toBe(false);
  });

  it("a comment mentioning trackSale is not reported as a double count", async () => {
    const commented = WEBHOOK.replace("await fulfill(session);", "// trackSale is documented elsewhere\n      await fulfill(session);");
    const dir = project(commented);
    const step = await wire(dir, { stripeAccountBound: true });
    expect(step.detail).not.toContain("already calls trackSale");
  });
});

const FLAGS = { json: false, noInteractive: false, autoConfirm: false, quiet: false, verbose: false, apiUrl: "http://test.local" };

/** A Fastify + Stripe app the detectors recognise, with the webhook above. */
function app(env?: string): string {
  const dir = project();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { fastify: "^4.0.0", stripe: "^14.0.0" } }));
  if (env !== undefined) writeFileSync(join(dir, ".env"), env);
  return dir;
}

async function onboardIn(dir: string, opts: Record<string, unknown> = {}, flags: Partial<typeof FLAGS> = {}) {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runOnboard({ apiKey: "key_a", yes: true, ...opts }, { ...FLAGS, ...flags });
  } finally {
    process.chdir(cwd);
  }
}

describe("runOnboard reads the binding and passes it on", () => {
  it("bound: webhook unchanged, and the wizard is told sales come from Stripe", async () => {
    apiState.status = { stripe_account_bound: true, stripe_connected: false };
    const dir = app();
    await onboardIn(dir);
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(wizardCalls[0]).toMatchObject({ stripeRecordsSales: true });
  });

  it("not bound: --yes leaves the webhook alone and the wizard gets unknown", async () => {
    apiState.status = { stripe_account_bound: false };
    const dir = app();
    await onboardIn(dir);
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(wizardCalls[0]).toMatchObject({ stripeRecordsSales: "unknown" });
  });

  it("an older CMS (stripe_connected only): unknown, so --yes leaves the webhook alone", async () => {
    apiState.status = { stripe_connected: true };
    const dir = app();
    await onboardIn(dir);
    expect(webhookOf(dir)).toBe(WEBHOOK);
  });

  it("the env file holds another program's key: the answer is not trusted, webhook unchanged", async () => {
    apiState.status = { stripe_account_bound: false };
    const dir = app("AFFITOR_API_KEY=key_b\n");
    await onboardIn(dir);
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("AFFITOR_API_KEY=key_b\n");
  });

  it("the env file holds the same key: the answer is used", async () => {
    apiState.status = { stripe_account_bound: true };
    const dir = app("AFFITOR_API_KEY=key_a\n");
    await onboardIn(dir);
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(wizardCalls[0]).toMatchObject({ stripeRecordsSales: true });
  });

  it.each([{ noInteractive: true }, { json: true }])('false stays manual with flags %j', async (flags) => {
    apiState.status = { stripe_account_bound: false };
    const dir = app();
    await onboardIn(dir, { yes: false }, flags);
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it('interactive false asks about possible Connect events before a diff can be confirmed', async () => {
    apiState.status = { stripe_account_bound: false };
    const dir = app();
    confirmAction.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await onboardIn(dir, { yes: false });
    expect(confirmAction.mock.calls[0][0]).toContain('shared account');
    expect(confirmAction).toHaveBeenCalledTimes(2);
    expect(webhookOf(dir)).toContain('await affitor.trackSale({');
  });

  it.each(['AFFITOR_API_KEY=key_b\n', 'export AFFITOR_API_KEY = key_b\n'])('key mismatch stays manual even interactively (%s)', async (env) => {
    apiState.status = { stripe_account_bound: false };
    const dir = app(env);
    confirmAction.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await onboardIn(dir, { yes: false });
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(env);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it('a runtime process key conflict cannot be overridden by answering the Connect question', async () => {
    vi.stubEnv('AFFITOR_API_KEY', 'key_b');
    apiState.status = { stripe_account_bound: false };
    const dir = app();
    confirmAction.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await onboardIn(dir, { yes: false });
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it.each([undefined, 'AFFITOR_API_KEY=key_b\n'])('never prints a full program key in the env diff or conflict advice', async (env) => {
    const key = 'test_program_key_not_a_real_secret';
    const dir = app(env);
    await onboardIn(dir, { apiKey: key });
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).not.toContain(key);
  });
});
