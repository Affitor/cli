import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { AffitorAPI } from "../src/lib/api-client";
import { runInit } from "../src/commands/init";
import { runStatus } from "../src/commands/status";
import { registerProgramsCommand } from "../src/commands/programs";
import { registerWhoamiCommand } from "../src/commands/whoami";
import { setLoggerOptions } from "../src/lib/logger";
import type { CLIFlags } from "../src/types";

// P1 stores public IDs privately and emits the existing numeric contract. These
// transport fixtures test the CLI consumer; CMS output hiding is tested by CMS.
// Stub only the home location: never read or replace the operator's credentials.
const sandbox = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  homedir: () => sandbox.home,
}));

const status = {
  program_id: 41, name: "Fixture program", domain: "fixture.example.invalid",
  dns_verified: false, stripe_connected: false, stripe_charges_enabled: false,
  recent_events: { clicks_24h: 2, leads_24h: 1, sales_24h: 0 },
  active_partners: 1, pending_commissions: 0,
};
const programs = [{ id: 41, name: status.name, domain: status.domain,
  status: "active", commission: "20% per sale", partners: 1, created_at: "2026-10-01T00:00:00.000Z" }];
const init = { program_id: 41, api_key: "fake_p1_application_key", program_slug: "fixture-program",
  domain: status.domain, link_param: "via" };
const auth = { status: "complete", token: "fake_p1_session", email: "fixture@example.invalid", advertiser_id: 7 };
const opaqueEvent = { event_type: "click", event_id: "test_0123456789abcdef", received: true,
  attributed: false, message: "Test event received" };

type Request = { method: string; url: URL; authorization?: string; body: unknown };

describe("P1 CLI compatibility over HTTP", () => {
  let server: Server;
  let root: string;
  let project: string;
  let cwd: string;
  let origin: string;
  let requests: Request[];
  let responseStatus: number;
  let errorBody: unknown;
  let output: MockInstance<typeof console.log>;
  const flags = (): CLIFlags => ({ json: true, noInteractive: true, autoConfirm: true,
    quiet: true, verbose: false, apiUrl: origin });
  const jsonOutput = () => JSON.parse(output.mock.calls.at(-1)![0] as string);
  const client = () => new AffitorAPI({ apiUrl: origin, apiKey: init.api_key });

  beforeEach(async () => {
    cwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), "affitor-p1-compat-"));
    sandbox.home = join(root, "home");
    project = join(root, "project");
    mkdirSync(join(sandbox.home, ".affitor"), { recursive: true });
    mkdirSync(project);
    writeFileSync(join(sandbox.home, ".affitor/credentials.json"), JSON.stringify({
      token: auth.token, email: auth.email, user_id: "3", advertiser_id: "7",
      expires_at: "2099-01-01T00:00:00.000Z", created_at: "2026-10-01T00:00:00.000Z",
    }));
    process.chdir(project);
    vi.stubEnv("AFFITOR_API_KEY", "");
    output = vi.spyOn(console, "log").mockImplementation(() => {});
    setLoggerOptions({ json: true, quiet: true, verbose: false });
    requests = [];
    responseStatus = 200;
    errorBody = {};
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      const url = new URL(req.url!, "http://fixture.invalid");
      requests.push({ method: req.method!, url, authorization: req.headers.authorization,
        body: text ? JSON.parse(text) : undefined });
      res.setHeader("content-type", "application/json");
      if (responseStatus !== 200) {
        res.writeHead(responseStatus).end(JSON.stringify(errorBody));
        return;
      }
      const data = new Map<string, unknown>([
        ["POST /api/v1/cli/init", init], ["GET /api/v1/cli/status", status],
        ["GET /api/v1/cli/programs", programs], ["GET /api/v1/cli/auth/poll", auth],
        ["POST /api/v1/cli/test-event", opaqueEvent],
      ]).get(`${req.method} ${url.pathname}`);
      if (data === undefined) { res.writeHead(404).end("{}"); return; }
      res.end(JSON.stringify({ data }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setLoggerOptions({ json: false, quiet: false, verbose: false });
  });

  it("init keeps numeric advertiser input, response, config and install snippet", async () => {
    await runInit({ name: status.name, domain: status.domain, commissionType: "percent", commissionRate: 20 }, flags());
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe(`Bearer ${auth.token}`);
    expect(requests[0].body).toMatchObject({ advertiser_id: 7, commission_rate: 20 });
    const config = JSON.parse(readFileSync(join(project, ".affitor/config.json"), "utf8"));
    expect(config).toMatchObject({ program_id: 41, ref_param: "via" });
    expect(jsonOutput()).toMatchObject({ program_id: 41, status: "created" });
    expect(jsonOutput().tracking.script_tag).toContain('data-affitor-program-id="41"');
    expect(readFileSync(join(project, ".affitor/.env"), "utf8")).toContain("AFFITOR_PROGRAM_ID=41\n");
    expect(readFileSync(join(project, ".affitor/AGENTS.md"), "utf8")).toContain('data-affitor-program-id="41"');
    expect(JSON.stringify(config)).not.toContain(init.api_key);
  });

  it.each([41, "41"])("status preserves numeric JSON and existing config bytes for program_id %j", async (id) => {
    mkdirSync(join(project, ".affitor"));
    const saved = JSON.stringify({ version: 2, program_id: id, domain: status.domain, api_url: origin });
    writeFileSync(join(project, ".affitor/config.json"), saved);
    await runStatus({ ...flags(), apiKey: init.api_key });
    expect(jsonOutput()).toEqual(status);
    expect(requests[0].url.searchParams.get("program_id")).toBe("41");
    expect(requests[0].authorization).toBe(`Bearer ${init.api_key}`);
    expect(readFileSync(join(project, ".affitor/config.json"), "utf8")).toBe(saved);
  });

  it("key-only status sends no selector and keeps numeric JSON", async () => {
    await runStatus({ ...flags(), apiKey: init.api_key });
    expect(jsonOutput()).toEqual(status);
    expect(requests[0].url.search).toBe("");
  });

  it("programs keeps numeric row ids using the saved session", async () => {
    const cmd = new Command().option("--json").option("--api-url <url>");
    registerProgramsCommand(cmd);
    await cmd.parseAsync(["programs", "--json", "--api-url", origin], { from: "user" });
    expect(jsonOutput()).toEqual({ programs });
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe(`Bearer ${auth.token}`);
  });

  it("whoami keeps its existing saved advertiser representation without a request", async () => {
    const cmd = new Command().option("--json");
    registerWhoamiCommand(cmd);
    await cmd.parseAsync(["whoami", "--json"], { from: "user" });
    expect(jsonOutput()).toMatchObject({ logged_in: true, advertiser_id: "7" });
    expect(requests).toHaveLength(0);
  });

  it("auth poll preserves numeric advertiser id and encodes the opaque poll state", async () => {
    expect(await client().authPoll("fixture /?&state")).toEqual(auth);
    expect(requests[0].url.searchParams.get("state")).toBe("fixture /?&state");
    expect(requests[0].url.searchParams.size).toBe(1);
  });

  it("the opaque CLI test event id is unchanged", async () => {
    expect(await client().sendTestEvent({ program_id: "41", event_type: "click" })).toEqual(opaqueEvent);
    expect(requests[0].body).toEqual({ program_id: "41", event_type: "click" });
  });

  it.each([
    ["999", 404], ["prg_00000000000000000000000001", 404], ["ptr_00000000000000000000000001", 400],
  ])("a rejected selector %s never retries without the selector", async (selector, code) => {
    responseStatus = code;
    errorBody = { error: { message: "Unresolved program", code: code === 404 ? "not_found" : "invalid_id" } };
    await expect(client().getStatus(selector)).rejects.toMatchObject({ status: code, message: "Unresolved program" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url.searchParams.get("program_id")).toBe(selector);
    expect(requests[0].method).toBe("GET");
  });
});
