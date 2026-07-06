import { afterEach, describe, expect, it, vi } from "vitest";
import { PolarAPI, PolarAPIError, POLAR_API_SANDBOX } from "../src/lib/polar-api";

interface Call {
  url: string;
  init: RequestInit;
}

/** Stub fetch with a queue of responses; records every call. */
function stubFetch(responses: Array<{ status: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
      };
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ENDPOINT = {
  id: "wh_1",
  url: "https://example.com/api/polar/webhook",
  format: "raw",
  secret: "polar_whs_test",
  events: ["order.paid", "order.refunded"],
};

describe("PolarAPI.createWebhookEndpoint", () => {
  it("POSTs /v1/webhooks/endpoints with format raw + events, Bearer auth; returns the secret", async () => {
    const calls = stubFetch([{ status: 201, body: ENDPOINT }]);
    const api = new PolarAPI("tok_123", POLAR_API_SANDBOX);
    const res = await api.createWebhookEndpoint({
      url: ENDPOINT.url,
      events: ["order.paid", "order.refunded"],
    });

    expect(res.secret).toBe("polar_whs_test");
    expect(calls[0].url).toBe(`${POLAR_API_SANDBOX}/v1/webhooks/endpoints`);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok_123");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({
      url: ENDPOINT.url,
      format: "raw",
      events: ["order.paid", "order.refunded"],
    });
  });
});

describe("PolarAPI.listWebhookEndpoints", () => {
  it("paginates until max_page and flattens items (each item carries the secret)", async () => {
    const calls = stubFetch([
      { status: 200, body: { items: [ENDPOINT], pagination: { max_page: 2 } } },
      { status: 200, body: { items: [{ ...ENDPOINT, id: "wh_2" }], pagination: { max_page: 2 } } },
    ]);
    const api = new PolarAPI("tok", POLAR_API_SANDBOX);
    const items = await api.listWebhookEndpoints();

    expect(items.map((i) => i.id)).toEqual(["wh_1", "wh_2"]);
    expect(items[0].secret).toBe("polar_whs_test");
    expect(calls[0].url).toContain("page=1&limit=100");
    expect(calls[1].url).toContain("page=2&limit=100");
  });
});

describe("PolarAPI.updateWebhookEndpointEvents", () => {
  it("PATCHes the endpoint with the merged events list", async () => {
    const calls = stubFetch([{ status: 200, body: ENDPOINT }]);
    const api = new PolarAPI("tok", POLAR_API_SANDBOX);
    await api.updateWebhookEndpointEvents("wh_1", ["order.paid", "order.refunded"]);

    expect(calls[0].url).toBe(`${POLAR_API_SANDBOX}/v1/webhooks/endpoints/wh_1`);
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      events: ["order.paid", "order.refunded"],
    });
  });
});

describe("PolarAPI errors", () => {
  it("401 → actionable Organization Access Token guidance", async () => {
    stubFetch([{ status: 401, body: {} }]);
    const api = new PolarAPI("bad", POLAR_API_SANDBOX);
    await expect(api.listWebhookEndpoints()).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("Organization Access Token"),
    });
  });

  it("422 → joins validation detail messages", async () => {
    stubFetch([
      {
        status: 422,
        body: { detail: [{ loc: ["body", "url"], msg: "invalid url", type: "value_error" }] },
      },
    ]);
    const api = new PolarAPI("tok", POLAR_API_SANDBOX);
    await expect(
      api.createWebhookEndpoint({ url: "nope", events: ["order.paid"] }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining("invalid url") });
  });

  it("string detail bodies surface directly", async () => {
    stubFetch([{ status: 403, body: { detail: "Missing scope webhooks:write" } }]);
    const api = new PolarAPI("tok", POLAR_API_SANDBOX);
    await expect(api.listWebhookEndpoints()).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("webhooks:write"),
    });
  });

  it("network failure → PolarAPIError with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const api = new PolarAPI("tok", POLAR_API_SANDBOX);
    await expect(api.listWebhookEndpoints()).rejects.toSatisfy(
      (e: unknown) => e instanceof PolarAPIError && e.status === 0,
    );
  });
});
