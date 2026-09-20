import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init";
import type { CLIFlags } from "../src/types";

/**
 * What `affitor init` says when the directory is already set up.
 *
 * Product rule: `init` creates a new program. It does not restore the program this directory
 * already points at, and it does not replace that program's API key. The message has to say
 * both, and name what does produce a new key: a workspace owner of the program regenerating
 * it in Settings → API Key.
 */

const flags: CLIFlags = {
  json: false,
  noInteractive: true,
  autoConfirm: true,
  quiet: false,
  verbose: false,
};

describe("affitor init in a directory that is already configured", () => {
  let home: string;
  let project: string;
  let cwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    cwd = process.cwd();
    originalHome = process.env.HOME;

    // A logged-in user, so init gets past the credentials check.
    home = mkdtempSync(join(tmpdir(), "affitor-home-"));
    mkdirSync(join(home, ".affitor"));
    writeFileSync(
      join(home, ".affitor", "credentials.json"),
      JSON.stringify({
        token: "jwt_test",
        email: "brand@example.test",
        expires_at: "2099-01-01T00:00:00.000Z",
      }),
    );
    process.env.HOME = home;

    // A project that already points at a program.
    project = mkdtempSync(join(tmpdir(), "affitor-init-"));
    mkdirSync(join(project, ".affitor"));
    writeFileSync(join(project, ".affitor", "config.json"), JSON.stringify({ version: 2 }));
    process.chdir(project);

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    process.chdir(cwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("says init creates a new program and names who can replace the key", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runInit({}, flags)).rejects.toThrow("exit:1");

    const out = stderr.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(out).toContain("`init` creates a new program");
    expect(out).toContain("does not restore this one");
    expect(out).toContain("does not replace its API key");
    expect(out).toContain("workspace owner of this program");
    expect(out).toContain("Affitor → Settings → API Key");
    expect(out).toContain("Regenerate");
    expect(out).not.toContain("to reinitialize");
  });
});
