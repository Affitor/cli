import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectStripeWebhook } from "../src/lib/webhook-detect";

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "affitor-hook-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const FASTIFY_WEBHOOK = `import Fastify from 'fastify';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_KEY!);
const app = Fastify();

app.post('/webhooks/stripe', async (req, reply) => {
  const sig = req.headers['stripe-signature'] as string;
  const event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);
  // handle event
  reply.send({ received: true });
});
`;

describe("detectStripeWebhook", () => {
  it("finds constructEvent and reports file + 1-based line (happy path)", () => {
    const dir = project({ "src/routes/webhooks.ts": FASTIFY_WEBHOOK });
    const hit = detectStripeWebhook(dir, "fastify");
    expect(hit).not.toBeNull();
    expect(hit!.file).toBe(join("src", "routes", "webhooks.ts"));
    expect(hit!.line).toBe(9); // line of the constructEvent call above
    expect(hit!.framework).toBe("fastify");
  });

  it("tailors the handlerHint per framework", () => {
    const dir = project({ "server.ts": FASTIFY_WEBHOOK });
    expect(detectStripeWebhook(dir, "fastify")!.handlerHint).toContain("fastify.post");
    expect(detectStripeWebhook(dir, "express")!.handlerHint).toContain("app.post");
    expect(detectStripeWebhook(dir, "next-app")!.handlerHint).toContain("app/api/webhooks/stripe/route.ts");
    expect(detectStripeWebhook(dir, "next-pages")!.handlerHint).toContain("pages/api/webhooks/stripe");
    expect(detectStripeWebhook(dir, "node")!.handlerHint).toContain("constructEvent");
  });

  it("defaults framework to unknown when not supplied", () => {
    const dir = project({ "index.js": FASTIFY_WEBHOOK });
    const hit = detectStripeWebhook(dir);
    expect(hit).not.toBeNull();
    expect(hit!.framework).toBe("unknown");
    expect(hit!.handlerHint).toContain("verified Stripe webhook event");
  });

  it("returns null when no webhook verification is present (no-match path)", () => {
    const dir = project({
      "src/server.ts": "import Fastify from 'fastify';\nconst app = Fastify();\n",
      "src/db.ts": "export const pool = {};\n",
    });
    expect(detectStripeWebhook(dir, "fastify")).toBeNull();
  });

  it("skips node_modules / dist / .next / .git when scanning", () => {
    const dir = project({
      "node_modules/stripe/index.js": "stripe.webhooks.constructEvent(a, b, c);",
      "dist/server.js": "stripe.webhooks.constructEvent(a, b, c);",
      ".next/x.js": "stripe.webhooks.constructEvent(a, b, c);",
      "src/clean.ts": "export const x = 1;\n",
    });
    expect(detectStripeWebhook(dir, "node")).toBeNull();
  });

  it("ignores non-source files (e.g. .json, .md)", () => {
    const dir = project({
      "notes.md": "we call stripe.webhooks.constructEvent here",
      "data.json": JSON.stringify({ note: "stripe.webhooks.constructEvent" }),
    });
    expect(detectStripeWebhook(dir, "node")).toBeNull();
  });
});
