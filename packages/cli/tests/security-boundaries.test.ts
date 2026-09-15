import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import open from "open";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBrowser } from "../src/commands/login";
import { writeSecrets } from "../src/lib/config";

vi.mock("open", () => ({
  default: vi.fn(() => Promise.resolve()),
}));

describe("local secret storage", () => {
  let cwd = "";

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it("writes the project secrets file with owner-only permissions", () => {
    cwd = mkdtempSync(join(tmpdir(), "affitor-secrets-"));

    writeSecrets({ api_key: "test-key", program_id: "123" }, cwd);

    expect(statSync(join(cwd, ".affitor", ".env")).mode & 0o777).toBe(0o600);
  });
});

describe("login browser opening", () => {
  const mockedOpen = vi.mocked(open);

  beforeEach(() => {
    mockedOpen.mockClear();
  });

  it("does not use a shell or child_process", () => {
    const source = readFileSync(
      new URL("../src/commands/login.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("node:child_process");
    expect(source).not.toMatch(/\bexec\s*\(/);
  });

  it("does not open non-HTTPS or malformed URLs", () => {
    openBrowser("http://example.com/login");
    openBrowser("not a URL");

    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it("opens a valid HTTPS URL without a shell", () => {
    openBrowser("https://affitor.com/login?state=test");

    expect(mockedOpen).toHaveBeenCalledOnce();
    expect(mockedOpen).toHaveBeenCalledWith("https://affitor.com/login?state=test");
  });
});
