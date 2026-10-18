import { describe, it, expect } from "vitest";
import { getRecipe, getIntegrationPlan } from "../src/index.js";

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
      "const affitorKey = session.metadata?.affitor_customer_key ?? session.client_reference_id;",
    );
    expect(sale).toContain("customerExternalId: affitorKey,");
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

/**
 * The snippets run inside the brand's own webhook, so they must never throw there: a throw
 * fails the webhook and the provider retries it. The SDK's trackSale throws synchronously
 * when it has no customer key (affiliate-sdk server.ts trackSale), so the stub below does the
 * same, and each snippet is run for real, with and without the key.
 */
describe("snippets never throw inside the brand's webhook (report 2026-10-17 #5)", () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

  function sdkStub() {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      trackSale(input: Record<string, unknown>) {
        if (!input.customerExternalId && !input.clickId) {
          throw new Error("Affitor.trackSale: `customerExternalId` or `clickId` is required");
        }
        calls.push(input);
        return Promise.resolve({ ok: true, status: 200 });
      },
    };
  }

  function quietConsole() {
    const warnings: string[] = [];
    return { warnings, console: { ...console, warn: (...a: unknown[]) => warnings.push(a.join(" ")) } };
  }

  /** The sale body without its import line, run with `vars` in scope. */
  async function runSale(provider: "stripe" | "paddle", vars: Record<string, unknown>) {
    const body = getRecipe("fastify", provider, "s2s").sale!.snippet.replace(/^import .*\n+/, "");
    const affitor = sdkStub();
    const c = quietConsole();
    const names = [...Object.keys(vars), "affitor", "console"];
    await new AsyncFunction(...names, body)(...Object.values(vars), affitor, c.console);
    return { calls: affitor.calls, warnings: c.warnings };
  }

  async function runRenewal(invoice: Record<string, unknown>) {
    const affitor = sdkStub();
    const c = quietConsole();
    const body = `switch (event.type) {\n${getRecipe("fastify", "stripe", "s2s").renewal!.snippet}\n}`;
    await new AsyncFunction("event", "affitor", "console", body)(
      { type: "invoice.paid", data: { object: invoice } },
      affitor,
      c.console,
    );
    return { calls: affitor.calls, warnings: c.warnings };
  }

  it("Stripe checkout without an Affitor key: logs, sends nothing, does not throw", async () => {
    const r = await runSale("stripe", { session: { id: "cs_1", amount_total: 4900, metadata: {} } });
    expect(r.calls).toEqual([]);
    expect(r.warnings.join("\n")).toContain("cs_1 has no affitor_customer_key");
  });

  it("Stripe checkout with the key (or only client_reference_id) reports the sale", async () => {
    const withKey = await runSale("stripe", {
      session: { id: "cs_2", amount_total: 4900, metadata: { affitor_customer_key: "u_1" } },
    });
    expect(withKey.calls).toEqual([{ customerExternalId: "u_1", amount: 4900, invoiceId: "cs_2" }]);
    const refOnly = await runSale("stripe", { session: { id: "cs_3", amount_total: 100, client_reference_id: "u_2" } });
    expect(refOnly.calls[0]).toMatchObject({ customerExternalId: "u_2", invoiceId: "cs_3" });
  });

  it("Stripe $0 checkout: nothing sent, nothing logged", async () => {
    const r = await runSale("stripe", { session: { id: "cs_4", amount_total: 0 } });
    expect(r.calls).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("Stripe renewal without an Affitor key: logs, sends nothing, does not throw", async () => {
    const r = await runRenewal({ id: "in_1", billing_reason: "subscription_cycle", amount_paid: 900 });
    expect(r.calls).toEqual([]);
    expect(r.warnings.join("\n")).toContain("in_1 has no affitor_customer_key");
  });

  it("Stripe renewal with the Basil key reports it", async () => {
    const r = await runRenewal({
      id: "in_2",
      billing_reason: "subscription_cycle",
      amount_paid: 900,
      parent: { subscription_details: { metadata: { affitor_customer_key: "u_3" }, subscription: "sub_1" } },
    });
    expect(r.calls).toEqual([
      expect.objectContaining({ customerExternalId: "u_3", amount: 900, invoiceId: "in_2", subscriptionId: "sub_1" }),
    ]);
  });

  it("Paddle without custom_data.user_id: sends nothing, does not throw", async () => {
    const r = await runSale("paddle", { data: { id: "txn_1", details: { totals: { total: "1000" } } } });
    expect(r.calls).toEqual([]);
    const ok = await runSale("paddle", {
      data: { id: "txn_2", custom_data: { user_id: "u_4" }, details: { totals: { total: "1000" } } },
    });
    expect(ok.calls).toEqual([{ customerExternalId: "u_4", amount: 1000, invoiceId: "txn_2" }]);
  });
});
