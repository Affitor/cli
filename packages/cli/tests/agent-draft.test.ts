import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planSetup } from "../src/lib/agent-setup.js";
import { AgentSetupError, installFromSetupCode, redeemSetupCode } from "../src/lib/program-agent-client.js";
import { DraftClient, agentCredential } from "../src/lib/draft-client.js";
import { draftPayload } from "../src/commands/draft.js";

const CODE = "aff_sc_" + "c".repeat(43);
const KEY = "aff_ag_" + "k".repeat(43);
const dirs: string[] = [], servers: Server[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function project() { const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-draft-"))); dirs.push(dir); return dir; }

async function api(handler: (method: string, path: string, body: any, auth?: string) => { status?: number; body: unknown }) {
  const requests: { method: string; path: string; body: any; auth?: string }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method!, path: req.url!, body, auth: req.headers.authorization });
    const answer = handler(req.method!, req.url!, body, req.headers.authorization);
    res.statusCode = answer.status ?? 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(answer.body));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubEnv("AFFITOR_AGENT_DEV_API_ORIGIN", origin);
  return { origin, requests };
}

describe("setup code", () => {
  it("redeems once, with no session, for the program the code names", async () => {
    const { origin, requests } = await api(() => ({ status: 201, body: { data: { id: 31, client: "claude_code", program_id: 10, api_key: KEY, grants: ["draft"] } } }));
    const credential = await redeemSetupCode(origin, CODE, "claude_code");
    expect(credential).toMatchObject({ id: 31, program_id: 10, client: "claude_code", api_url: origin, api_key: KEY });
    expect(requests).toEqual([{ method: "POST", path: "/api/v1/agent-setup-codes/redeem", body: { code: CODE, client: "claude_code", name: "claude_code" }, auth: undefined }]);
  });

  it.each([
    ["code_used", /already used.*revoke the new key/],
    ["code_expired", /expired/],
    ["code_cancelled", /cancelled/],
    ["issuer_changed", /can no longer create agent keys/],
  ])("%s answers in plain words", async (code, message) => {
    const { origin } = await api(() => ({ status: 410, body: { error: { code, message: "server text" } } }));
    await expect(redeemSetupCode(origin, CODE, "cursor")).rejects.toThrow(message);
  });

  it("refuses a malformed code before any request, and non-Affitor origins", async () => {
    const { origin, requests } = await api(() => ({ body: {} }));
    await expect(redeemSetupCode(origin, "aff_sc_short", "codex")).rejects.toThrow(/Expected a setup code/);
    await expect(redeemSetupCode("https://evil.example", CODE, "codex")).rejects.toThrow(/only to https:\/\/api.affitor.com/);
    expect(requests).toEqual([]);
  });

  it("installs one client's private credential; more than one client is refused before redeeming", async () => {
    const { origin, requests } = await api(() => ({ status: 201, body: { data: { id: 32, client: "claude_code", program_id: 10, api_key: KEY } } }));
    const root = project();
    await expect(installFromSetupCode(planSetup(root, ["claude_code", "cursor"], { agentKeys: true }), CODE, origin)).rejects.toBeInstanceOf(AgentSetupError);
    expect(requests).toEqual([]);
    const installed = await installFromSetupCode(planSetup(root, ["claude_code"], { agentKeys: true }), CODE, origin);
    expect(installed).toEqual([expect.objectContaining({ client: "claude_code", id: 32, state: "minted" })]);
    expect(JSON.parse(readFileSync(join(root, ".affitor/agents/claude_code.json"), "utf8"))).toMatchObject({ id: 32, program_id: 10, api_key: KEY });
  });
});

describe("draft", () => {
  function setUp(root: string, origin: string, clients = ["claude_code"]) {
    mkdirSync(join(root, ".affitor/agents"), { recursive: true });
    for (const client of clients) {
      writeFileSync(join(root, ".affitor/agents", `${client}.json`), JSON.stringify({ version: 1, id: 7, program_id: 10, client, api_url: origin, created_at: "2026-10-20T00:00:00Z", credential_note: "fake", api_key: KEY }));
    }
  }

  it("uses the only saved agent key, or asks for --client", async () => {
    const root = project();
    expect(() => agentCredential(root)).toThrow(/No agent key/);
    setUp(root, "http://127.0.0.1:1", ["claude_code", "cursor"]);
    expect(() => agentCredential(root)).toThrow(/More than one agent/);
    expect(agentCredential(root, "cursor").client).toBe("cursor");
  });

  it("set replaces the draft it just read (draft_id + revision); with none it opens one", async () => {
    let open: any = { id: 5, revision: 2, payload_hash: "h", status: "open", payload: { name: "A" }, changes: [], stale_fields: [] };
    const { origin, requests } = await api((method, _path, body) => {
      if (method === "GET") return { body: { draft: open } };
      open = open ? { ...open, revision: open.revision + 1, payload: body.payload } : { id: 6, revision: 1, payload_hash: "h", status: "open", payload: body.payload, changes: [], stale_fields: [] };
      return { body: { draft: open } };
    });
    const root = project(); setUp(root, origin);
    const client = new DraftClient(agentCredential(root));
    expect((await client.set({ name: "B" }))?.revision).toBe(3);
    expect(requests.map(r => [r.method, r.path, r.body, r.auth])).toEqual([
      ["GET", "/api/v1/programs/10/draft", undefined, `Bearer ${KEY}`],
      ["PUT", "/api/v1/programs/10/draft", { payload: { name: "B" }, draft_id: 5, revision: 2 }, `Bearer ${KEY}`],
    ]);
    open = null;
    await client.set({ name: "C" });
    expect(requests.at(-1)!.body).toEqual({ payload: { name: "C" } });
    expect(client.applyUrl()).toBe("https://affitor.com/brand/setup/business?programId=10");
  });

  it("server refusals come back as plain words with the field reasons", async () => {
    const { origin } = await api(() => ({ status: 400, body: { error: { code: "validation_failed", message: "x", fields: { payment: "An agent cannot set this field." } } } }));
    const root = project(); setUp(root, origin);
    await expect(new DraftClient(agentCredential(root)).show()).rejects.toThrow("Some fields are not valid. payment: An agent cannot set this field.");
  });

  it("flags shape the payload; a commission needs type and rate", () => {
    expect(draftPayload({ name: "Kyma", website: "https://kyma.dev", type: "recurring", rate: "20", months: "12" }))
      .toEqual({ name: "Kyma", website: "https://kyma.dev", commission: { type: "recurring", rate_pct: 20, duration_months: 12 } });
    expect(() => draftPayload({ rate: "20" })).toThrow(/needs --type/);
    expect(() => draftPayload({})).toThrow(/Nothing to draft/);
    expect(draftPayload({ file: "x.json" }, () => '{"tagline":"Fast"}')).toEqual({ tagline: "Fast" });
  });
});

describe("built command", () => {
  function run(root: string, args: string[], origin: string) {
    return new Promise<{ status: number | null; stdout: string }>((resolveRun, reject) => {
      const child = spawn(process.execPath, [resolve("dist/cli.js"), ...args], {
        cwd: root, windowsHide: true,
        env: { PATH: process.env.PATH ?? "", HOME: root, USERPROFILE: root, AFFITOR_AGENT_DEV_API_ORIGIN: origin, CLAUDECODE: "", CODEX: "", CODEX_THREAD_ID: "", CURSOR_AGENT: "" },
      });
      let stdout = "";
      child.stdout.on("data", chunk => stdout += chunk);
      const timer = setTimeout(() => { child.kill(); reject(new Error("CLI timed out")); }, 10_000);
      child.on("error", reject);
      child.on("close", status => { clearTimeout(timer); resolveRun({ status, stdout }); });
    });
  }

  it("agent setup --code installs the key without a login, prints no secret; draft set then writes", async () => {
    const { origin, requests } = await api((method, path, body) => {
      if (path === "/api/v1/agent-setup-codes/redeem") return { status: 201, body: { data: { id: 40, client: "claude_code", program_id: 10, api_key: KEY } } };
      if (method === "GET") return { body: { draft: null } };
      return { body: { draft: { id: 1, revision: 1, payload_hash: "h", status: "open", payload: body.payload, changes: [], stale_fields: [] } } };
    });
    const root = project();
    const setup = await run(root, ["--api-url", origin, "--json", "agent", "setup", "--client", "claude_code", "--code", CODE, "--yes"], origin);
    expect(setup.stdout).not.toContain(KEY);
    expect(JSON.parse(setup.stdout.trim().split("\n").at(-1)!)).toMatchObject({ status: "needs_next_step" });
    expect(requests.map(r => r.path)).toEqual(["/api/v1/agent-setup-codes/redeem"]);
    const drafted = await run(root, ["draft", "set", "--name", "Kyma", "--type", "recurring", "--rate", "20", "--months", "12"], origin);
    expect(JSON.parse(drafted.stdout)).toMatchObject({ status: "drafted", next: expect.stringContaining("programId=10") });
    expect(requests.at(-1)).toMatchObject({ method: "PUT", path: "/api/v1/programs/10/draft", auth: `Bearer ${KEY}`, body: { payload: { name: "Kyma", commission: { type: "recurring", rate_pct: 20, duration_months: 12 } } } });
  });
});
