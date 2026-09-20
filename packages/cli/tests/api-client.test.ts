import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AffitorAPI,
  APIError,
  resetReportedWarnings,
} from "../src/lib/api-client";

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

// The wire shapes the API sends for a key that has to be replaced: a `warnings[]`
// entry while the key still works, a 401 envelope once it is past the deadline.
const ROTATION_WARNING = {
  code: "api_key_rotation_required",
  message: "This API key must be replaced by 2026-10-03.",
  hint: "Create a new key in Affitor → Settings → API Key, then update AFFITOR_API_KEY on your server.",
  rotate_by: "2026-10-03T00:00:00Z",
  docs_url: "https://docs.affitor.com/api-reference/errors#api_key_rotation_required",
};

const ROTATION_ERROR = {
  error: {
    code: "api_key_rotation_required",
    message: "This API key was retired on 2026-10-03.",
    hint: "Create a new key in Affitor → Settings → API Key.",
    docs_url: "https://docs.affitor.com/api-reference/errors#api_key_rotation_required",
  },
};

describe("AffitorAPI key-rotation signal", () => {
  const api = new AffitorAPI({ apiUrl: "http://test.local" });

  beforeEach(() => {
    resetReportedWarnings();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports a response warning as one stderr line carrying message and hint", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" }, warnings: [ROTATION_WARNING] });

    await api.getStatus("1");

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

    await api.getStatus("1");

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("returns the unwrapped payload unchanged when a warning rides along", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" }, warnings: [ROTATION_WARNING] });

    await expect(api.getStatus("1")).resolves.toMatchObject({ program_id: "1" });
  });

  it("reports the same warning once, not once per request in a command", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(200, { data: { program_id: "1" }, warnings: [ROTATION_WARNING] });

    await api.getStatus("1");
    await api.getStatus("1");
    await api.listPrograms();

    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("turns the 401 into an error that names the fix, not a bare 401", async () => {
    stubFetch(401, ROTATION_ERROR);

    await expect(api.getStatus("1")).rejects.toMatchObject({
      status: 401,
      code: "api_key_rotation_required",
    });
  });

  it("carries the retired-key hint in the thrown message", async () => {
    stubFetch(401, ROTATION_ERROR);

    try {
      await api.getStatus("1");
      throw new Error("expected getStatus to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(APIError);
      expect((e as APIError).message).toContain(ROTATION_ERROR.error.message);
      expect((e as APIError).message).toContain("Create a new key in Affitor");
    }
  });
});
