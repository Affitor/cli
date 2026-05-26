import { afterEach, describe, expect, it, vi } from "vitest";
import { AffitorAPI, APIError } from "../src/lib/api-client";

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    })),
  );
}

describe("AffitorAPI error parsing", () => {
  const api = new AffitorAPI({ apiUrl: "http://test.local" });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("extracts message from a Strapi error object (regression: no [object Object])", async () => {
    stubFetch(400, { error: { message: "Program not found", status: 400 } });
    await expect(api.getStatus("1")).rejects.toMatchObject({
      message: "Program not found",
      status: 400,
    });
  });

  it("uses a plain string error body directly", async () => {
    stubFetch(401, { error: "Invalid token" });
    await expect(api.getStatus("1")).rejects.toMatchObject({
      message: "Invalid token",
    });
  });

  it("falls back to a top-level message field", async () => {
    stubFetch(403, { message: "Forbidden" });
    await expect(api.getStatus("1")).rejects.toMatchObject({
      message: "Forbidden",
    });
  });

  it("falls back to status text for an empty body", async () => {
    stubFetch(500, {});
    await expect(api.getStatus("1")).rejects.toMatchObject({
      message: "API returned 500",
    });
  });

  it("never surfaces the literal [object Object] for object errors", async () => {
    stubFetch(400, { error: { message: "Bad request", details: { x: 1 } } });
    try {
      await api.getStatus("1");
      throw new Error("expected getStatus to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(APIError);
      expect((e as APIError).message).not.toContain("[object Object]");
    }
  });
});
