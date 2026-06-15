import { afterEach, describe, expect, it, vi } from "vitest";
import { AffitorAPI } from "../src/lib/api-client";

/**
 * Stub global fetch with a single response. `headers` is an optional map read
 * back through a `.get()` shim (mirrors the real Headers API the client uses).
 */
function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null },
      json: async () => body,
    })),
  );
}

const api = new AffitorAPI({ apiUrl: "http://test.local", apiKey: "key_test" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AffitorAPI.getReadiness", () => {
  it("returns the readiness verdict on 200", async () => {
    stubFetch(200, {
      data: {
        integration_verified: false,
        gates: [{ id: "click", passed: true }, { id: "sale", passed: false, next_action: "Send a sale" }],
        next_action: "Send a sale",
      },
    });
    const r = await api.getReadiness();
    expect(r.integration_verified).toBe(false);
    expect(r.gates).toHaveLength(2);
    expect(r.next_action).toBe("Send a sale");
  });

  it("unwraps a bare (non-data-wrapped) body too", async () => {
    stubFetch(200, { integration_verified: true });
    const r = await api.getReadiness();
    expect(r.integration_verified).toBe(true);
  });

  it("throws (APIError) on a non-2xx readiness response", async () => {
    stubFetch(401, { error: "Invalid token" });
    await expect(api.getReadiness()).rejects.toMatchObject({ message: "Invalid token" });
  });
});

describe("AffitorAPI.runVerificationChain", () => {
  it("returns the verdict from a 2xx { data } envelope", async () => {
    stubFetch(200, { data: { verdict: { click: true, lead: true, sale: true }, attributed: true } });
    const r = await api.runVerificationChain();
    expect(r.verdict).toEqual({ click: true, lead: true, sale: true });
    expect(r.attributed).toBe(true);
    expect(r.rate_limited).toBeUndefined();
  });

  it("does NOT throw on 429 — returns rate_limited + retry_after_seconds from the body", async () => {
    stubFetch(
      429,
      { error: { code: "rate_limited", retry_after_seconds: 42 } },
      { "Retry-After": "42" },
    );
    const r = await api.runVerificationChain();
    expect(r.rate_limited).toBe(true);
    expect(r.retry_after_seconds).toBe(42);
    expect(r.http_status).toBe(429);
  });

  it("falls back to the Retry-After header when the body omits retry_after_seconds", async () => {
    stubFetch(429, { error: { code: "rate_limited" } }, { "Retry-After": "7" });
    const r = await api.runVerificationChain();
    expect(r.rate_limited).toBe(true);
    expect(r.retry_after_seconds).toBe(7);
  });

  it("flags other non-2xx without throwing (so the caller can decide)", async () => {
    stubFetch(500, { error: { message: "boom" } });
    const r = await api.runVerificationChain();
    expect(r.rate_limited).toBe(false);
    expect(r.http_status).toBe(500);
  });
});
