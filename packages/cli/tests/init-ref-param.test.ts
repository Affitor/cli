import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refParamFrom, runInit } from "../src/commands/init";
import { AffitorAPI } from "../src/lib/api-client";
import type { CLIFlags } from "../src/types";

const flags: CLIFlags = { json: true, noInteractive: true, autoConfirm: true, quiet: true, verbose: false };
const opts = { name: "Demo", domain: "demo.example.test", commissionType: "percent", commissionRate: 20 };

describe("refParamFrom", () => {
  test("via and aff pass through; a missing or unknown value is aff", () => {
    expect(refParamFrom({ link_param: "via" })).toBe("via");
    expect(refParamFrom({ link_param: "aff" })).toBe("aff");
    expect(refParamFrom({})).toBe("aff");
    expect(refParamFrom({ link_param: "ref" })).toBe("aff");
    expect(refParamFrom({ link_param: "VIA" })).toBe("aff");
  });
});

describe("affitor init writes ref_param from the server", () => {
  let home: string;
  let project: string;
  let cwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    cwd = process.cwd();
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "affitor-home-"));
    mkdirSync(join(home, ".affitor"));
    writeFileSync(
      join(home, ".affitor", "credentials.json"),
      JSON.stringify({ token: "jwt_test", email: "brand@example.test", expires_at: "2099-01-01T00:00:00.000Z" }),
    );
    process.env.HOME = home;
    project = mkdtempSync(join(tmpdir(), "affitor-init-"));
    process.chdir(project);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const config = () => JSON.parse(readFileSync(join(project, ".affitor", "config.json"), "utf8"));

  it.each([
    [{ link_param: "via" }, "via"],
    [{ link_param: "aff" }, "aff"],
    [{}, "aff"],
    [{ link_param: "ref" }, "aff"],
    [{ link_param: 7 }, "aff"],
  ])("init response %j → ref_param %s in .affitor/config.json", async (extra, expected) => {
    const init = vi
      .spyOn(AffitorAPI.prototype, "initProgram")
      .mockResolvedValue({ program_id: "58", api_key: "aff_test_key", ...extra } as never);

    await runInit(opts, flags);

    expect(init).toHaveBeenCalledTimes(1);
    expect(config().ref_param).toBe(expected);
    expect(config().program_id).toBe("58");
  });

  it("an existing config is left as it is: no API call, no write", async () => {
    mkdirSync(join(project, ".affitor"));
    const before = JSON.stringify({ version: 2, program_id: "12", ref_param: "aff" });
    writeFileSync(join(project, ".affitor", "config.json"), before);
    const init = vi.spyOn(AffitorAPI.prototype, "initProgram");

    await expect(runInit(opts, flags)).rejects.toThrow("exit:1");

    expect(init).not.toHaveBeenCalled();
    expect(readFileSync(join(project, ".affitor", "config.json"), "utf8")).toBe(before);
    expect(existsSync(join(project, ".affitor", ".env"))).toBe(false);
  });
});
