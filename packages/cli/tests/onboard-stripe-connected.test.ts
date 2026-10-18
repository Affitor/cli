import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const confirmAction = vi.fn<(message: string) => Promise<boolean>>();
vi.mock("../src/lib/prompts.js", () => ({ confirmAction: (m: string) => confirmAction(m) }));

const { readStripeConnected, wireServerSale } = await import("../src/commands/onboard");

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
  confirmAction.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("wireServerSale — Stripe connected in Affitor", () => {
  it("adds no trackSale and leaves the webhook unchanged, even with --yes", async () => {
    const dir = project();
    const step = await wire(dir, { stripeConnected: true });
    expect(step).toMatchObject({ step: "server_sale", status: "skipped" });
    expect(step.detail).toContain("stripe connected");
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("points out a webhook that already calls trackSale (it counts each payment twice)", async () => {
    const wired = WEBHOOK.replace("await fulfill(session);", "await affitor.trackSale({ customerExternalId: 'u', amount: 1, invoiceId: session.id });");
    const dir = project(wired);
    const step = await wire(dir, { stripeConnected: true });
    expect(step.status).toBe("skipped");
    expect(step.detail).toContain("already calls trackSale");
    expect(webhookOf(dir)).toBe(wired);
  });
});

describe("wireServerSale — Stripe not connected", () => {
  it("adds the sale call as before (--yes)", async () => {
    const dir = project();
    const step = await wire(dir, { stripeConnected: false });
    expect(step).toMatchObject({ status: "ok", detail: HOOK_FILE });
    expect(webhookOf(dir)).toContain("await affitor.trackSale({");
  });
});

describe("wireServerSale — connection unknown", () => {
  it("with --yes (nobody to ask): webhook unchanged, reported as manual", async () => {
    const dir = project();
    const step = await wire(dir, { stripeConnected: undefined });
    expect(step.status).toBe("manual");
    expect(step.detail).toContain("unknown");
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("in --json mode: webhook unchanged, nobody asked", async () => {
    const dir = project();
    const step = await wire(dir, { stripeConnected: undefined, json: true, autoConfirm: false, interactive: true });
    expect(step.status).toBe("manual");
    expect(webhookOf(dir)).toBe(WEBHOOK);
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("interactive, answer yes (connected): no trackSale added", async () => {
    const dir = project();
    confirmAction.mockResolvedValueOnce(true);
    const step = await wire(dir, { stripeConnected: undefined, interactive: true, autoConfirm: false });
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(confirmAction.mock.calls[0][0]).toContain("Is Stripe connected");
    expect(step.status).toBe("skipped");
    expect(webhookOf(dir)).toBe(WEBHOOK);
  });

  it("interactive, answer no: shows the diff and adds the call once confirmed", async () => {
    const dir = project();
    confirmAction.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const step = await wire(dir, { stripeConnected: undefined, interactive: true, autoConfirm: false });
    expect(confirmAction).toHaveBeenCalledTimes(2);
    expect(step.status).toBe("ok");
    expect(webhookOf(dir)).toContain("await affitor.trackSale({");
  });
});

describe("readStripeConnected", () => {
  it("reads stripe_connected from GET /v1/cli/status", async () => {
    expect(await readStripeConnected({ getStatus: async () => ({ stripe_connected: true }) as never })).toBe(true);
    expect(await readStripeConnected({ getStatus: async () => ({ stripe_connected: false }) as never })).toBe(false);
  });

  it("is undefined when the call fails or the field is missing (the caller asks)", async () => {
    expect(
      await readStripeConnected({
        getStatus: async () => {
          throw new Error("network");
        },
      }),
    ).toBeUndefined();
    expect(await readStripeConnected({ getStatus: async () => ({}) as never })).toBeUndefined();
  });
});
