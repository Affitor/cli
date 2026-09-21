import { afterEach, describe, expect, it, vi } from "vitest";
import { AffitorAPI, APIError } from "../src/lib/api-client";

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k] ?? null },
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

// The wire shapes the API sends for a key that has to be replaced: a `warnings[]`
// entry while the key still works, a 401 envelope once it is past the deadline.
const ROTATION_WARNING = {
  code: "api_key_rotation_required",
  message: "This API key must be replaced by 2026-10-03.",
  hint: "Create a new key in Affitor → Settings → API Key, then update AFFITOR_API_KEY on your server.",
  rotate_by: "2026-10-03T00:00:00Z",
  docs_url: "https://docs.affitor.com/api-reference/errors#api_key_rotation_required",
};

/** A fresh client, the way each command run builds exactly one. */
function client(): AffitorAPI {
  return new AffitorAPI({ apiUrl: "http://test.local" });
}

const ROTATION_ERROR = {
  error: {
    code: "api_key_rotation_required",
    message: "This API key was retired on 2026-10-03.",
    hint: "Create a new key in Affitor → Settings → API Key.",
    docs_url: "https://docs.affitor.com/api-reference/errors#api_key_rotation_required",
  },
};

describe("AffitorAPI key-rotation signal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports a response warning as one stderr line carrying message and hint", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" }, warnings: [ROTATION_WARNING] });

    await client().getStatus("1");

    expect(stderr).toHaveBeenCalledTimes(1);
    const line = stderr.mock.calls[0][0] as string;
    expect(line).toContain(ROTATION_WARNING.message);
    expect(line).toContain(ROTATION_WARNING.hint);
    expect(line).not.toContain("\n");
  });

  it("keeps warnings off stdout so --json output stays parseable", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" }, warnings: [ROTATION_WARNING] });

    await client().getStatus("1");

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("returns the unwrapped payload unchanged when a warning rides along", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" }, warnings: [ROTATION_WARNING] });

    await expect(client().getStatus("1")).resolves.toMatchObject({ program_id: "1" });
  });

  it("reports the same warning once, not once per request in a command", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" }, warnings: [ROTATION_WARNING] });
    const api = client();

    await api.getStatus("1");
    await api.getStatus("1");
    await api.listPrograms();

    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("warns again for a second client, so a second run is never silent", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" }, warnings: [ROTATION_WARNING] });

    // Two clients in one process stand for two runs of the command: the memory
    // belongs to the client, so the second run hears the warning too.
    await client().getStatus("1");
    await client().getStatus("1");

    expect(stderr).toHaveBeenCalledTimes(2);
  });

  it("warns again after the client's memory is reset", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" }, warnings: [ROTATION_WARNING] });
    const api = client();

    await api.getStatus("1");
    api.resetReportedWarnings();
    await api.getStatus("1");

    expect(stderr).toHaveBeenCalledTimes(2);
  });

  it("still reports a warning that rides on a 400, and keeps the error intact", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    stubFetch(400, { error: { message: "Program not found" }, warnings: [ROTATION_WARNING] });

    await expect(client().getStatus("1")).rejects.toMatchObject({
      status: 400,
      message: "Program not found",
    });

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0][0]).toContain(ROTATION_WARNING.message);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("still reports a warning that rides on a 500, and keeps the error intact", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    stubFetch(500, { error: { message: "boom" }, warnings: [ROTATION_WARNING] });

    await expect(client().getStatus("1")).rejects.toMatchObject({
      status: 500,
      message: "boom",
    });

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0][0]).toContain(ROTATION_WARNING.message);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("still reports a warning that rides on a 429, and keeps the rate-limit error", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    stubFetch(
      429,
      { error: { code: "rate_limited" }, warnings: [ROTATION_WARNING] },
      { "Retry-After": "7" },
    );

    await expect(client().getStatus("1")).rejects.toMatchObject({
      status: 429,
      message: "Rate limited. Wait 7 seconds and try again.",
    });

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0][0]).toContain(ROTATION_WARNING.message);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("turns the 401 into an error that names the fix, not a bare 401", async () => {
    stubFetch(401, ROTATION_ERROR);

    await expect(client().getStatus("1")).rejects.toMatchObject({
      status: 401,
      code: "api_key_rotation_required",
    });
  });

  it("carries the retired-key hint in the thrown message", async () => {
    stubFetch(401, ROTATION_ERROR);

    try {
      await client().getStatus("1");
      throw new Error("expected getStatus to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(APIError);
      expect((e as APIError).message).toContain(ROTATION_ERROR.error.message);
      expect((e as APIError).message).toContain("Create a new key in Affitor");
    }
  });
});

// The headers the API sets on EVERY response made with a flagged key, including the
// 401 after the deadline — where the body is a bare error envelope and `warnings[]`
// is gone. They are the only rotation signal left in that case (W37-1362).
const ROTATION_DOCS_URL =
  "https://docs.affitor.com/api-reference/errors#api_key_rotation_required";
const ROTATION_HEADERS = {
  Deprecation: "@1790035200",
  Sunset: "Sat, 03 Oct 2026 00:00:00 GMT",
  Link: `<${ROTATION_DOCS_URL}>; rel="deprecation"`,
};

describe("AffitorAPI key-rotation headers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports the deadline and the docs link from headers alone, with no warnings in the body", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" } }, ROTATION_HEADERS);

    await client().getStatus("1");

    expect(stderr).toHaveBeenCalledTimes(1);
    const line = stderr.mock.calls[0][0] as string;
    expect(line).toContain("2026-10-03");
    expect(line).toContain(ROTATION_DOCS_URL);
    expect(line).not.toContain("\n");
  });

  // The case this ticket exists for: past the deadline the API returns 401 and stops
  // sending `warnings[]`, so a client that only reads the body goes silent exactly
  // when the user most needs to be told.
  it("still reports from headers on the 401 after the deadline, where the body has no warnings", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(401, ROTATION_ERROR, ROTATION_HEADERS);

    await expect(client().getStatus("1")).rejects.toMatchObject({ status: 401 });

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0][0]).toContain(ROTATION_DOCS_URL);
  });

  it("reports the header signal once per run, not once per request", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" } }, ROTATION_HEADERS);
    const api = client();

    await api.getStatus("1");
    await api.getStatus("1");
    await api.listPrograms();

    expect(stderr).toHaveBeenCalledTimes(1);
  });

  // Both signals carry the same news, so they share one dedupe key: the body warning
  // is richer and gets there first, the headers stay quiet behind it.
  it("reports once, not twice, when the body warning and the headers both arrive", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(
      200,
      { data: { program_id: "1" }, warnings: [ROTATION_WARNING] },
      ROTATION_HEADERS,
    );

    await client().getStatus("1");

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0][0]).toContain(ROTATION_WARNING.hint);
  });

  it("says nothing when the response carries no rotation headers", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" } });

    await client().getStatus("1");

    expect(stderr).not.toHaveBeenCalled();
  });

  it("keeps the header notice off stdout so --json output stays parseable", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" } }, ROTATION_HEADERS);

    await expect(client().getStatus("1")).resolves.toMatchObject({ program_id: "1" });

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  // A header is a side signal: a value the CLI cannot read must never take down a
  // command that is otherwise working. `new Date("not-a-date").toISOString()` throws.
  it("survives an unparseable Sunset without throwing or printing the raw value", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(
      200,
      { data: { program_id: "1" } },
      { ...ROTATION_HEADERS, Sunset: "not-a-date" },
    );

    await expect(client().getStatus("1")).resolves.toMatchObject({ program_id: "1" });

    expect(stderr).toHaveBeenCalledTimes(1);
    const line = stderr.mock.calls[0][0] as string;
    expect(line).not.toContain("not-a-date");
    expect(line).not.toContain("Invalid Date");
    expect(line).toContain(ROTATION_DOCS_URL);
  });

  // `runVerificationChain` deliberately bypasses `request()` (a 429 there is expected
  // and must not throw), so it needs the header read wired in separately.
  it("reports from headers on the verification chain, which does not go through request()", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { verdict: "pass" } }, ROTATION_HEADERS);

    await client().runVerificationChain();

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0][0]).toContain(ROTATION_DOCS_URL);
  });

  it("reports again after the client's memory is reset, headers included", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" } }, ROTATION_HEADERS);
    const api = client();

    await api.getStatus("1");
    api.resetReportedWarnings();
    await api.getStatus("1");

    expect(stderr).toHaveBeenCalledTimes(2);
  });
});
