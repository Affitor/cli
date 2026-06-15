import { describe, expect, it } from "vitest";
import { getRecipe } from "@affitor/recipes";
import { injectStripeTrackSale } from "../src/lib/inject";

// The canonical Stripe sale snippet, sourced from the recipe registry (the same
// thing `affitor onboard` injects). Body reads `session.*`.
const SALE_SNIPPET = getRecipe("fastify", "stripe", "s2s").sale!.snippet;

// Import specifier as onboard.ts would compute for a webhook at
// src/app/api/webhooks/stripe/route.ts when the client lives at src/lib/affitor.ts.
const IMPORT_SPECIFIER = "../../../lib/affitor";
const IMPORT_LINE = `import { affitor } from '${IMPORT_SPECIFIER}';`;

// A clean Fastify webhook: verifies the event, switches on type, binds
// `const session = event.data.object` in the checkout.session.completed case.
const CLEAN_FASTIFY = `import Fastify from 'fastify';
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

describe("injectStripeTrackSale — injected (clean shape)", () => {
  it("inserts trackSale right after the session binding, at its indent", () => {
    const r = injectStripeTrackSale(CLEAN_FASTIFY, { saleSnippet: SALE_SNIPPET });
    expect(r.status).toBe("injected");
    expect(r.content).toContain("await affitor.trackSale({");
    expect(r.content).toContain("Affitor: report the sale");
    expect(r.added.length).toBeGreaterThan(0);

    // The call lands AFTER the session binding (so `session` is in scope) and
    // BEFORE the existing fulfill() call.
    const bindingIdx = r.content.indexOf("const session = event.data.object");
    const saleIdx = r.content.indexOf("await affitor.trackSale({");
    const fulfillIdx = r.content.indexOf("await fulfill(session)");
    expect(bindingIdx).toBeLessThan(saleIdx);
    expect(saleIdx).toBeLessThan(fulfillIdx);

    // The inserted call matches the session binding's indentation (6 spaces).
    expect(r.content).toMatch(/\n {6}await affitor\.trackSale\(\{/);
  });

  it("adds the affitor import line to content and added[] when importSpecifier is given", () => {
    const r = injectStripeTrackSale(CLEAN_FASTIFY, {
      saleSnippet: SALE_SNIPPET,
      importSpecifier: IMPORT_SPECIFIER,
    });
    expect(r.status).toBe("injected");
    // Import line present in the transformed content.
    expect(r.content).toContain(IMPORT_LINE);
    // Import line appears before the trackSale call.
    expect(r.content.indexOf(IMPORT_LINE)).toBeLessThan(r.content.indexOf("await affitor.trackSale({"));
    // Import line is the first entry in added[].
    expect(r.added[0]).toBe(IMPORT_LINE);
  });

  it("does not add an import when importSpecifier is omitted", () => {
    const r = injectStripeTrackSale(CLEAN_FASTIFY, { saleSnippet: SALE_SNIPPET });
    expect(r.status).toBe("injected");
    // No affitor client import added (only the trackSale call block).
    expect(r.content).not.toContain("import { affitor } from");
    expect(r.added.every((l) => !l.startsWith("import { affitor }"))).toBe(true);
  });

  it("does not strip the original code (only adds the sale block)", () => {
    const r = injectStripeTrackSale(CLEAN_FASTIFY, { saleSnippet: SALE_SNIPPET });
    expect(r.content).toContain("stripe.webhooks.constructEvent");
    expect(r.content).toContain("await fulfill(session)");
    expect(r.content).toContain("reply.send({ received: true })");
  });

  it("respects an explicit indent override", () => {
    const r = injectStripeTrackSale(CLEAN_FASTIFY, { saleSnippet: SALE_SNIPPET, indent: "" });
    expect(r.status).toBe("injected");
    expect(r.content).toMatch(/\nawait affitor\.trackSale\(\{/);
  });
});

describe("injectStripeTrackSale — already (idempotent)", () => {
  it("is a no-op when affitor.trackSale is already present", () => {
    const once = injectStripeTrackSale(CLEAN_FASTIFY, {
      saleSnippet: SALE_SNIPPET,
      importSpecifier: IMPORT_SPECIFIER,
    }).content;
    const twice = injectStripeTrackSale(once, {
      saleSnippet: SALE_SNIPPET,
      importSpecifier: IMPORT_SPECIFIER,
    });
    expect(twice.status).toBe("already");
    expect(twice.content).toBe(once);
    expect(twice.added).toHaveLength(0);
  });

  it("idempotent re-run has exactly ONE import line and ONE trackSale call", () => {
    const once = injectStripeTrackSale(CLEAN_FASTIFY, {
      saleSnippet: SALE_SNIPPET,
      importSpecifier: IMPORT_SPECIFIER,
    }).content;
    const twice = injectStripeTrackSale(once, {
      saleSnippet: SALE_SNIPPET,
      importSpecifier: IMPORT_SPECIFIER,
    });
    // Content is unchanged — exactly one of each.
    const importCount = (twice.content.match(new RegExp(IMPORT_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    const saleCount = (twice.content.match(/affitor\.trackSale\(/g) ?? []).length;
    expect(importCount).toBe(1);
    expect(saleCount).toBe(1);
    expect(twice.added).toHaveLength(0);
  });

  it("treats an @affitor/sdk/server import as already-wired", () => {
    const withImport = `import { Affitor } from '@affitor/sdk/server';\n${CLEAN_FASTIFY}`;
    const r = injectStripeTrackSale(withImport, { saleSnippet: SALE_SNIPPET });
    expect(r.status).toBe("already");
    expect(r.content).toBe(withImport);
  });

  it("treats an existing affitor client import line as already-wired", () => {
    // If the import specifier line is already in the file, skip (even without trackSale).
    const withClientImport = `${IMPORT_LINE}\n${CLEAN_FASTIFY}`;
    const r = injectStripeTrackSale(withClientImport, {
      saleSnippet: SALE_SNIPPET,
      importSpecifier: IMPORT_SPECIFIER,
    });
    expect(r.status).toBe("already");
    expect(r.content).toBe(withClientImport);
    expect(r.added).toHaveLength(0);
  });
});

describe("injectStripeTrackSale — unrecognized (conservative, prints patch)", () => {
  it("bails when there is no constructEvent (not a verified webhook)", () => {
    const noVerify = `app.post('/webhooks/stripe', (req, reply) => {
  const session = event.data.object;
  reply.send({ ok: true });
});
`;
    const r = injectStripeTrackSale(noVerify, { saleSnippet: SALE_SNIPPET });
    expect(r.status).toBe("unrecognized");
    expect(r.content).toBe(noVerify);
  });

  it("bails when checkout.session.completed is absent (different event)", () => {
    const otherEvent = `const event = stripe.webhooks.constructEvent(body, sig, secret);
if (event.type === 'invoice.paid') {
  const invoice = event.data.object;
  handle(invoice);
}
`;
    const r = injectStripeTrackSale(otherEvent, { saleSnippet: SALE_SNIPPET });
    expect(r.status).toBe("unrecognized");
  });

  it("bails when checkout.session.completed appears more than once (ambiguous)", () => {
    const ambiguous = `const event = stripe.webhooks.constructEvent(body, sig, secret);
// We branch on checkout.session.completed in two places:
if (event.type === 'checkout.session.completed') {
  const session = event.data.object;
  a(session);
}
function isCompleted(t) { return t === 'checkout.session.completed'; }
`;
    const r = injectStripeTrackSale(ambiguous, { saleSnippet: SALE_SNIPPET });
    expect(r.status).toBe("unrecognized");
  });

  it("bails when there is no clean `const session = …` binding to anchor on", () => {
    // constructEvent + a single completed reference, but the object is bound to
    // a name we don't recognize — too risky to place the session-keyed call.
    const oddBinding = `const event = stripe.webhooks.constructEvent(body, sig, secret);
if (event.type === 'checkout.session.completed') {
  const obj = event.data.object;
  fulfill(obj);
}
`;
    const r = injectStripeTrackSale(oddBinding, { saleSnippet: SALE_SNIPPET });
    expect(r.status).toBe("unrecognized");
    expect(r.content).toBe(oddBinding);
  });

  it("bails when the provided snippet is not a trackSale call", () => {
    const r = injectStripeTrackSale(CLEAN_FASTIFY, { saleSnippet: "console.log('nope');" });
    expect(r.status).toBe("unrecognized");
    expect(r.content).toBe(CLEAN_FASTIFY);
  });
});
