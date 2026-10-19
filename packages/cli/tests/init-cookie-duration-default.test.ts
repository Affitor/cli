import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerInitCommand, runInit } from "../src/commands/init";
import { setLoggerOptions } from "../src/lib/logger";
import type { CLIFlags } from "../src/types";

const fixture = vi.hoisted(() => ({
  home: "",
  input: vi.fn(async (options: { default?: string }) => options.default ?? ""),
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => fixture.home,
}));
vi.mock("@inquirer/prompts", () => ({
  input: fixture.input,
  select: vi.fn(),
  confirm: vi.fn(),
}));

const options = { name: "Example", domain: "example.test", commissionType: "percent", commissionRate: 20 };

describe("new program cookie duration", () => {
  let sandbox: string;
  let project: string;
  let previousCwd: string;
  let server: Server;
  let flags: CLIFlags;
  let requests: { method?: string; path?: string; body: Record<string, unknown> }[];

  beforeEach(async () => {
    previousCwd = process.cwd();
    sandbox = mkdtempSync(join(tmpdir(), "affitor-init-duration-"));
    fixture.home = join(sandbox, "home");
    project = join(sandbox, "project");
    mkdirSync(join(fixture.home, ".affitor"), { recursive: true });
    mkdirSync(project);
    writeFileSync(join(fixture.home, ".affitor", "credentials.json"), JSON.stringify({
      token: "fixture-session", email: "brand@example.test", expires_at: "2099-01-01T00:00:00.000Z",
    }));
    process.chdir(project);
    fixture.input.mockReset().mockImplementation(async (question) => question.default ?? "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    setLoggerOptions({ quiet: true, json: true });
    requests = [];
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ method: req.method, path: req.url, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ program_id: "42", api_key: "fixture-program-key", link_param: "aff" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    flags = { json: true, noInteractive: true, autoConfirm: true, quiet: true, verbose: false,
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    process.chdir(previousCwd);
    rmSync(sandbox, { recursive: true, force: true });
    setLoggerOptions({ quiet: false, json: false });
    vi.restoreAllMocks();
  });

  function expectDuration(days: number) {
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/api/v1/cli/init", body: { cookie_duration: days } });
    const saved = JSON.parse(readFileSync(join(project, ".affitor", "config.json"), "utf8"));
    expect(saved.cookie.duration_days).toBe(days);
    expect(saved.program_id).toBe("42");
  }

  it("omitting the unattended option sends and saves 60 days", async () => {
    await runInit(options, flags);
    expectDuration(60);
    expect(fixture.input).not.toHaveBeenCalled();
  });

  it("accepting the real interactive prompt default sends and saves 60 days", async () => {
    await runInit(options, { ...flags, noInteractive: false });
    expect(fixture.input).toHaveBeenCalledWith(expect.objectContaining({ message: "Cookie duration (days):", default: "60" }));
    expectDuration(60);
  });

  it.each([30, 90, 365])("an explicit %i-day option is retained and bypasses the prompt", async (cookieDuration) => {
    await runInit({ ...options, cookieDuration }, { ...flags, noInteractive: false });
    expectDuration(cookieDuration);
    expect(fixture.input).not.toHaveBeenCalled();
  });

  it("an interactive user can still choose 90 days", async () => {
    fixture.input.mockResolvedValueOnce("90");
    await runInit(options, { ...flags, noInteractive: false });
    expectDuration(90);
  });

  it("the registered CLI parser retains --cookie-duration 90", async () => {
    const command = new Command().option("--no-interactive").option("--json").option("--api-url <url>");
    registerInitCommand(command);
    await command.parseAsync(["node", "affitor", "--no-interactive", "--json", "--api-url", flags.apiUrl!,
      "init", "--name", options.name, "--domain", options.domain, "--commission-type", options.commissionType,
      "--commission-rate", String(options.commissionRate), "--cookie-duration", "90"]);
    expectDuration(90);
  });

  it.each([undefined, 30])("an existing project's config, key and instructions remain byte-identical (option %s)", async (cookieDuration) => {
    mkdirSync(join(project, ".affitor"));
    const files = {
      ".affitor/config.json": JSON.stringify({ version: 2, program_id: "existing", cookie: { duration_days: 90 } }),
      ".affitor/.env": "AFFITOR_API_KEY=test_old\n",
      "AGENTS.md": "Existing project instructions.\n",
    };
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(project, name), contents);
    await expect(runInit({ ...options, cookieDuration }, flags)).rejects.toThrow("exit:1");
    expect(requests).toHaveLength(0);
    expect(fixture.input).not.toHaveBeenCalled();
    for (const [name, contents] of Object.entries(files)) expect(readFileSync(join(project, name), "utf8")).toBe(contents);
  });
});
