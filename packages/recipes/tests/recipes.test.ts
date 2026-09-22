import { describe, it, expect } from "vitest";
import {
  getRecipe,
  getIntegrationPlan,
  getWebhookRoute,
  POLAR_WEBHOOK_EVENTS,
} from "../src/index.js";

describe("getRecipe — install + verify (invariant)", () => {
  it("install is always `npm i @affitor/sdk` and verify mentions the synthetic chain + readiness", () => {
    const r = getRecipe("next-app", "stripe", "stripe_connect");
    expect(r.install).toBe("npm i @affitor/sdk");
    expect(r.verify).toContain("synthetic chain");
    expect(r.verify).toContain("readiness");
    expect(r.verify).toContain("integration_verified:true");
  });
});

describe("getRecipe — sale_path & sale (stripe_connect mode = Connect)", () => {
  it.each(["next-app", "next-pages", "fastify", "express", "unknown"] as const)(
    "%s + stripe_connect → sale_path 'connect', sale null (metadata only)",
    (framework) => {
      const r = getRecipe(framework, "stripe", "stripe_connect");
      expect(r.sale_path).toBe("connect");
      expect(r.sale).toBeNull();
      // Connect path always carries the metadata snippet.
      expect(r.metadata.snippet).toContain("subscription_data");
      expect(r.metadata.snippet).toContain("affitor_click_id");
    },
  );
});

describe("getRecipe — sale_path & inject_target (s2s mode)", () => {
  it("known framework + s2s → 'webhook_sdk' with a sale snippet + framework inject_target", () => {
    const next = getRecipe("next-app", "stripe", "s2s");
    expect(next.sale_path).toBe("webhook_sdk");
    expect(next.sale).not.toBeNull();
    expect(next.sale!.snippet).toContain("import { Affitor } from '@affitor/sdk/server';");
    expect(next.sale!.snippet).toContain("affitor.trackSale");
    expect(next.sale!.inject_target).toContain("app/api/webhooks/stripe/route.ts");

    const fastify = getRecipe("fastify", "stripe", "s2s");
    expect(fastify.sale_path).toBe("webhook_sdk");
    expect(fastify.sale!.inject_target).toContain("fastify.post('/webhooks/stripe'");

    const express = getRecipe("express", "stripe", "s2s");
    expect(express.sale_path).toBe("webhook_sdk");
    expect(express.sale!.inject_target).toContain("app.post('/webhooks/stripe'");
  });

  it("unknown framework + s2s → 'raw_http' (sale present, raw call)", () => {
    const r = getRecipe("unknown", "stripe", "s2s");
    expect(r.sale_path).toBe("raw_http");
    expect(r.sale).not.toBeNull();
    expect(r.sale!.snippet).toContain("affitor.trackSale");
    expect(r.sale!.inject_target).toContain("your payment webhook handler");
  });
});

describe("getIntegrationPlan — steps shape", () => {
  it("defaults mode to stripe_connect and returns ordered steps + recipe", () => {
    const plan = getIntegrationPlan({ framework: "next-app", provider: "stripe" });
    expect(plan.recipe.mode).toBe("stripe_connect");
    expect(plan.recipe.sale_path).toBe("connect");
    expect(Array.isArray(plan.steps)).toBe(true);
    // detect → install → metadata → sale → verify = 5 steps.
    expect(plan.steps).toHaveLength(5);
    expect(plan.steps[0]).toContain("Detect");
    expect(plan.steps[1]).toContain("npm i @affitor/sdk");
    expect(plan.steps[2]).toContain("Metadata");
    // Connect path: explicit "do NOT inject trackSale".
    expect(plan.steps[3]).toMatch(/Do NOT inject trackSale/);
    expect(plan.steps[4]).toContain("Verify");
  });

  it("s2s plan references the inject target in the sale step", () => {
    const plan = getIntegrationPlan({ framework: "fastify", provider: "stripe", mode: "s2s" });
    expect(plan.recipe.sale_path).toBe("webhook_sdk");
    expect(plan.steps).toHaveLength(6);
    expect(plan.steps[3]).toContain("fastify.post('/webhooks/stripe'");
  });
});

describe("getRecipe — Stripe sale snippet reads the key the metadata writes (B1)", () => {
  it("the sale snippet reads session.metadata.affitor_customer_key — the SAME key the metadata step plants", () => {
    const r = getRecipe("fastify", "stripe", "s2s");
    expect(r.sale).not.toBeNull();
    const sale = r.sale!.snippet;
    // The metadata step writes affitor_customer_key into session.metadata.
    expect(r.metadata.snippet).toContain("affitor_customer_key: user.id");
    // The sale step must READ that same key (with client_reference_id only as a fallback).
    expect(sale).toContain(
      "customerExternalId: session.metadata?.affitor_customer_key ?? session.client_reference_id",
    );
    // It must NOT read client_reference_id alone (the old, attribution-losing contract).
    expect(sale).not.toMatch(/customerExternalId:\s*session\.client_reference_id,/);
  });

  it("guards against $0 / setup-mode sessions (M1) so the SDK never throws on a non-positive amount", () => {
    const sale = getRecipe("fastify", "stripe", "s2s").sale!.snippet;
    expect(sale).toContain("if (session.amount_total && session.amount_total > 0)");
    // The trackSale call lives inside the guard.
    const guardIdx = sale.indexOf("if (session.amount_total");
    const callIdx = sale.indexOf("await affitor.trackSale(");
    expect(guardIdx).toBeLessThan(callIdx);
  });
});

describe("getRecipe — Stripe renewal reads Basil + legacy metadata (M2)", () => {
  it("renewal reads invoice.parent.subscription_details first, falling back to the legacy path", () => {
    const r = getRecipe("fastify", "stripe", "s2s");
    expect(r.renewal).toBeDefined();
    const snippet = r.renewal!.snippet;
    // Basil (2025-03-31+) path first.
    expect(snippet).toContain("invoice.parent?.subscription_details?.metadata?.affitor_customer_key");
    // Legacy fallback for pre-Basil accounts.
    expect(snippet).toContain("invoice.subscription_details?.metadata?.affitor_customer_key");
    // The note documents the API-version nuance.
    expect(r.renewal!.note).toContain("Basil");
  });
});

describe("getRecipe — subscription renewals (#3 invoice.paid)", () => {
  it("stripe + s2s → renewal present (invoice.paid, isRecurring, idempotent invoice id)", () => {
    const r = getRecipe("fastify", "stripe", "s2s");
    expect(r.renewal).toBeDefined();
    expect(r.renewal!.snippet).toContain("case 'invoice.paid'");
    expect(r.renewal!.snippet).toContain("isRecurring: true");
    expect(r.renewal!.snippet).toContain("invoiceId: invoice.id");
    expect(r.renewal!.snippet).toContain("subscription_cycle");
  });

  it("renewal skips $0 invoices (100%-off / credit) — guards a non-positive amount the SDK rejects", () => {
    const r = getRecipe("fastify", "stripe", "s2s");
    expect(r.renewal!.snippet).toContain("invoice.amount_paid <= 0");
  });

  it("renewal subscriptionId reads the Basil parent path first, falling back to legacy", () => {
    const r = getRecipe("fastify", "stripe", "s2s");
    expect(r.renewal!.snippet).toContain("invoice.parent?.subscription_details?.subscription");
  });

  it("stripe_connect mode → NO renewal (Connect autocaptures renewals)", () => {
    expect(getRecipe("fastify", "stripe", "stripe_connect").renewal).toBeUndefined();
  });

  it("non-stripe provider → NO renewal", () => {
    expect(getRecipe("fastify", "polar", "s2s").renewal).toBeUndefined();
  });

  it("getIntegrationPlan includes a Renewals step for stripe s2s", () => {
    const plan = getIntegrationPlan({ framework: "fastify", provider: "stripe", mode: "s2s" });
    expect(plan.steps.some((s) => s.startsWith) && plan.steps.some((s) => /Renewals:/.test(s))).toBe(true);
  });
});

describe("getRecipe — Polar sale snippet (SDK-parsed camelCase contract)", () => {
  // Field names verified against the @polar-sh SDK-parsed payload (the
  // Webhooks()/validateEvent helpers deliver camelCase objects — the raw
  // webhook JSON's snake_case names would be undefined there).
  const sale = getRecipe("next-app", "polar", "s2s").sale!.snippet;

  it("reads the SDK's camelCase order fields, never raw snake_case", () => {
    expect(sale).toContain("order.totalAmount");
    expect(sale).toContain("order.subscriptionId");
    expect(sale).toContain("order.customerId");
    expect(sale).not.toContain("total_amount");
    expect(sale).not.toContain("subscription_id ?");
    expect(sale).not.toContain("customer_id");
  });

  it("resolves the customer: planted metadata → customer.externalId → Polar's customerId", () => {
    expect(sale).toContain("order.metadata?.user_id");
    expect(sale).toContain("order.customer?.externalId");
    expect(sale).toContain("?? order.customerId");
  });

  it("carries the click id — planted metadata first, checkout-link reference_id fallback", () => {
    expect(sale).toContain("order.metadata?.affitor_click_id");
    expect(sale).toContain("order.metadata?.reference_id");
  });

  it("marks renewals precisely via billingReason (renewals ride order.paid)", () => {
    expect(sale).toContain("saleType: order.subscriptionId ? 'subscription' : 'payment'");
    // billing_reason enum (openapi): purchase | subscription_create |
    // subscription_cycle | subscription_update — only _cycle is a renewal.
    expect(sale).toContain("isRecurring: order.billingReason === 'subscription_cycle'");
    expect(sale).toContain("invoiceId: order.id");
  });

  it("metadata step documents BOTH carriers: server-side metadata and ?reference_id= links", () => {
    const metadata = getRecipe("next-app", "polar", "s2s").metadata;
    expect(metadata.snippet).toContain("affitor_click_id: affitorClickId");
    expect(metadata.snippet).toContain("user_id: user.id");
    expect(metadata.snippet).toContain("reference_id=<affitor_click_id>");
    expect(metadata.why).toContain("order.metadata.reference_id");
  });
});

describe("getWebhookRoute — Polar × next-app glue route", () => {
  it("returns the generated route for polar/next-app only", () => {
    expect(getWebhookRoute("next-app", "polar")).not.toBeNull();
    expect(getWebhookRoute("next-pages", "polar")).toBeNull();
    expect(getWebhookRoute("fastify", "polar")).toBeNull();
    expect(getWebhookRoute("next-app", "stripe")).toBeNull();
    expect(getWebhookRoute("unknown", "polar")).toBeNull();
  });

  it("route metadata: App Router path, deps, env vars, events", () => {
    const route = getWebhookRoute("next-app", "polar")!;
    expect(route.path).toBe("app/api/polar/webhook/route.ts");
    expect(route.deps).toContain("@polar-sh/nextjs");
    expect(route.deps).toContain("@affitor/sdk");
    expect(route.env.map((e) => e.name)).toEqual(["POLAR_WEBHOOK_SECRET", "AFFITOR_API_KEY"]);
    expect(route.events).toEqual(["order.paid", "order.refunded"]);
    expect([...POLAR_WEBHOOK_EVENTS]).toEqual(["order.paid", "order.refunded"]);
  });

  it("source validates the signature via Webhooks() and reads env, not literals", () => {
    const src = getWebhookRoute("next-app", "polar")!.source;
    expect(src).toContain("import { Webhooks } from '@polar-sh/nextjs';");
    expect(src).toContain("import { Affitor } from '@affitor/sdk/server';");
    expect(src).toContain("webhookSecret: process.env.POLAR_WEBHOOK_SECRET!");
    expect(src).toContain("process.env.AFFITOR_API_KEY");
  });

  it("source embeds the SAME canonical sale body as the printed recipe (no drift)", () => {
    const src = getWebhookRoute("next-app", "polar")!.source;
    // Spot-check the contract-bearing lines from SALE_SNIPPET_BODY.polar.
    expect(src).toContain("order.metadata?.affitor_click_id ?? order.metadata?.reference_id");
    expect(src).toContain("amount: order.totalAmount");
    expect(src).toContain("saleType: order.subscriptionId ? 'subscription' : 'payment'");
  });

  it("source guards $0 orders, tolerates 409 redeliveries, and handles refunds", () => {
    const src = getWebhookRoute("next-app", "polar")!.source;
    expect(src).toContain("if (!order.totalAmount || order.totalAmount <= 0) return;");
    expect(src).toContain("res.status !== 409");
    expect(src).toContain("onOrderRefunded");
    expect(src).toContain("trackRefund({ invoiceId: order.id })");
  });

  it("source contains the trackSale marker onboard uses for idempotency detection", () => {
    // `injectPolarTrackSale` / onboard treat `affitor.trackSale(` as already-wired.
    const src = getWebhookRoute("next-app", "polar")!.source;
    expect(src).toContain("affitor.trackSale({");
  });
});
