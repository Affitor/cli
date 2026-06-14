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
    expect(plan.steps).toHaveLength(5);
    expect(plan.steps[3]).toContain("fastify.post('/webhooks/stripe'");
  });
});
