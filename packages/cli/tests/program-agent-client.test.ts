import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applySetup, doctor, planSetup } from "../src/lib/agent-setup.js";
import { AGENT_LAUNCHER, type StoredAgentCredential } from "../src/lib/agent-launcher.js";
import { AgentSetupError, ProgramAgentClient, agentApiOrigin, installProgramAgents } from "../src/lib/program-agent-client.js";

const directories: string[] = [], servers: Server[] = [];
const cleanEnv = { ...process.env, CLAUDECODE: "", CODEX: "", CODEX_THREAD_ID: "", CURSOR_AGENT: "", AFFITOR_API_KEY: "fake_inherited_live_key" };
const key = (id: number) => "aff_ag_" + String(id).padStart(43, "x");
function project() { const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-mint-"))); directories.push(dir); return dir; }
function put(root: string, file: string, content: string) { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, { mode: 0o600 }); }
async function fixture() {
  const requests: { method: string; path: string; auth: string | undefined; body: unknown }[] = [];
  const rows: { id: number; client: string; key_hint: string; status: string; revoked_at?: string | null }[] = [];
  const behavior = { failMintAt: 0, loseMint: false, failRevoke: false, invalidMint: false, paginate: false, redirectMint: false };
  let mintCount = 0;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, body });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      if (req.url === "/api/v1/cli/programs") return res.end(JSON.stringify({ data: [{ id: 10, name: "Fixture" }] }));
      const before = new URL(req.url!, "http://fixture.test").searchParams.get("before");
      const ordered = rows.filter(row => !before || row.id < Number(before)).sort((a, b) => b.id - a.id);
      const data = behavior.paginate ? ordered.slice(0, 100) : ordered;
      return res.end(JSON.stringify({ data, meta: { next_cursor: data.length < ordered.length ? data.at(-1)!.id : null } }));
    }
    if (req.method === "POST") {
      mintCount++;
      if (behavior.redirectMint) { res.statusCode = 307; res.setHeader("Location", "/mint-redirect-target"); return res.end(); }
      if (behavior.failMintAt === mintCount) { res.statusCode = 502; return res.end(JSON.stringify({ error: "fake_inherited_live_key fixture_user_jwt server-private-error" })); }
      const id = 200 + mintCount;
      const row = { id, client: body.client, key_hint: `aff_ag_…${key(id).slice(-4)}`, status: "waiting" }; rows.push(row);
      if (behavior.loseMint) return req.socket.destroy();
      return res.end(JSON.stringify({ data: { ...row, api_key: behavior.invalidMint ? "invalid_key" : key(id) } }));
    }
    if (behavior.failRevoke) { res.statusCode = 500; return res.end('{"error":"server-private-error"}'); }
    const row = rows.find(row => row.id === Number(req.url!.split("/").at(-1)));
    if (row) row.status = "revoked";
    res.end(JSON.stringify({ data: { revoked: true } }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubEnv("AFFITOR_AGENT_DEV_API_ORIGIN", origin);
  return { origin, api: new ProgramAgentClient("fixture_user_jwt", origin), requests, rows, behavior };
}
function stored(origin: string, client = "claude_code", id = 1): StoredAgentCredential {
  return { version: 1, id, program_id: 10, client, api_url: origin, created_at: "2026-10-18T00:00:00Z", credential_note: "Fake test credential; not verified.", api_key: key(id) };
}
function run(root: string, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve("dist/cli.js"), ...args], { cwd: root, env: { ...cleanEnv, AFFITOR_AGENT_DEV_API_ORIGIN: process.env.AFFITOR_AGENT_DEV_API_ORIGIN ?? "", HOME: root, USERPROFILE: root }, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(new Error("Fixture CLI timed out")); }, 10_000);
    child.on("error", reject); child.on("close", status => { clearTimeout(timer); resolveRun({ status, stdout, stderr }); });
  });
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("user JWT origin boundary", () => {
  beforeEach(() => { vi.stubEnv("AFFITOR_AGENT_DEV_API_ORIGIN", ""); });
  it.each([
    "https://untrusted.example.test", "https://api.affitor.com.example.test",
    "https://other.affitor.com", "https://api.affitor.com:8443",
    "http://127.0.0.1:1337", "https://localhost:1337",
  ])("rejects %s before attaching a JWT or making HTTP requests", origin => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    expect(() => new ProgramAgentClient("fixture_user_jwt", origin)).toThrow(AgentSetupError);
    expect(request).not.toHaveBeenCalled();
  });
  it("permits only the production origin by default", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 10, name: "Fixture" }] })));
    vi.stubGlobal("fetch", request);
    expect(agentApiOrigin("https://API.AFFITOR.COM:443/")).toBe("https://api.affitor.com");
    await new ProgramAgentClient("fixture_user_jwt", "https://api.affitor.com").programs();
    expect(request).toHaveBeenCalledWith("https://api.affitor.com/api/v1/cli/programs", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer fixture_user_jwt" }) }));
  });
  it.each(["http://127.0.0.1:1337", "http://localhost:1337", "https://[::1]:1337"])("requires an exact explicit loopback development origin: %s", origin => {
    vi.stubEnv("AFFITOR_AGENT_DEV_API_ORIGIN", origin);
    expect(agentApiOrigin(origin)).toBe(origin);
    expect(() => agentApiOrigin(origin.replace(":1337", ":1338"))).toThrow(AgentSetupError);
  });
  it.each(["https://untrusted.example.test", "https://other.affitor.com", "http://localhost:1337/path", "http://user:pass@localhost:1337", "*"])("development configuration cannot authorize %s", value => {
    vi.stubEnv("AFFITOR_AGENT_DEV_API_ORIGIN", value);
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    expect(() => new ProgramAgentClient("fixture_user_jwt", value)).toThrow(AgentSetupError);
    expect(request).not.toHaveBeenCalled();
    expect(agentApiOrigin("https://api.affitor.com")).toBe("https://api.affitor.com");
  });
});

describe("authenticated per-client setup against local HTTP CMS", () => {
  it("mints independently, preserves app live key, uses only user JWT lifecycle and reuses keys without tool calls", async () => {
    const root = project(), cms = await fixture();
    put(root, ".affitor/.env", "AFFITOR_API_KEY=fake_application_key\n");
    const result = await installProgramAgents(planSetup(root, ["claude_code", "cursor"], { agentKeys: true }), 10, cms.api);
    expect(result.map(row => row.state)).toEqual(["minted", "minted"]);
    const claude = JSON.parse(readFileSync(join(root, ".affitor/agents/claude_code.json"), "utf8"));
    const cursor = JSON.parse(readFileSync(join(root, ".affitor/agents/cursor.json"), "utf8"));
    expect(claude.id).not.toBe(cursor.id); expect(claude.api_key).not.toBe(cursor.api_key);
    expect(readFileSync(join(root, ".affitor/.env"), "utf8")).toBe("AFFITOR_API_KEY=fake_application_key\n");
    if (process.platform !== "win32") expect(statSync(join(root, ".affitor/agents/claude_code.json")).mode & 0o777).toBe(0o600);
    const config = readFileSync(join(root, ".mcp.json"), "utf8"); expect(config).not.toContain(claude.api_key);
    expect(JSON.parse(config).mcpServers.affitor.args).toEqual([join(root, ".affitor/agent-mcp.cjs"), "claude_code"]);
    expect(cms.requests.every(req => req.auth === "Bearer fixture_user_jwt")).toBe(true);
    expect(cms.requests.filter(req => req.method === "POST").map(req => req.body)).toEqual([{ name: "claude_code", client: "claude_code" }, { name: "cursor", client: "cursor" }]);
    expect(() => planSetup(root, ["claude_code"])).toThrow("Pass --program-id");
    expect(doctor(root, ["claude_code"])[0]).toMatchObject({ status: "aligned", credential: "present_unverified", liveSession: "not_checked" });
    const before = readFileSync(join(root, ".affitor/agents/claude_code.json"));
    const again = await installProgramAgents(planSetup(root, ["claude_code", "cursor"], { agentKeys: true }), 10, cms.api);
    expect(again.map(row => row.state)).toEqual(["reused", "reused"]); expect(cms.requests.filter(req => req.method === "POST")).toHaveLength(2);
    expect(readFileSync(join(root, ".affitor/agents/claude_code.json"))).toEqual(before);
    expect(cms.requests.some(req => /readiness|status|test-event/.test(req.path))).toBe(false);
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    expect(spawnSync("git", ["-C", root, "check-ignore", ".affitor/agents/claude_code.json"]).status).toBe(0);
  });
  it("replaces a revoked selected key without changing another client", async () => {
    const root = project(), cms = await fixture();
    await installProgramAgents(planSetup(root, ["claude_code", "cursor"], { agentKeys: true }), 10, cms.api);
    const cursor = readFileSync(join(root, ".affitor/agents/cursor.json")); cms.rows[0].status = "revoked";
    await installProgramAgents(planSetup(root, ["claude_code"], { agentKeys: true }), 10, cms.api);
    expect(cms.rows).toHaveLength(3); expect(cms.rows[1].status).toBe("waiting");
    expect(readFileSync(join(root, ".affitor/agents/cursor.json"))).toEqual(cursor);
  });
  it("finds reusable old credentials across pagination", async () => {
    const root = project(), cms = await fixture(); cms.behavior.paginate = true;
    for (let id = 1; id <= 103; id++) cms.rows.push({ id, client: "claude_code", key_hint: `aff_ag_…${key(id).slice(-4)}`, status: "waiting" });
    put(root, ".affitor/agents/claude_code.json", JSON.stringify(stored(cms.origin)));
    const result = await installProgramAgents(planSetup(root, ["claude_code"], { agentKeys: true }), 10, cms.api);
    expect(result[0].state).toBe("reused"); expect(cms.requests.map(req => req.path)).toEqual(["/api/v1/programs/10/agents", "/api/v1/programs/10/agents?before=4"]);
  });
  it.each([false, true])("compensates partial mint; failed revoke is explicit (%s)", async failRevoke => {
    const root = project(), cms = await fixture(); cms.behavior.failMintAt = 2; cms.behavior.failRevoke = failRevoke;
    const error = await installProgramAgents(planSetup(root, ["claude_code", "cursor"], { agentKeys: true }), 10, cms.api).catch(error => error);
    expect(error).toBeInstanceOf(AgentSetupError); expect(error.cleanupIds).toEqual(failRevoke ? [201] : []); expect(error.uncertainMint).toBe(true);
    expect(cms.requests.filter(req => req.method === "POST")).toHaveLength(2); expect(cms.requests.filter(req => req.method === "DELETE")).toHaveLength(1);
    expect(error.message).not.toContain("server-private-error"); expect(error.message).not.toContain("fixture_user_jwt"); expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });
  it("does not retry a lost mint response and reports its unknown row", async () => {
    const root = project(), cms = await fixture(); cms.behavior.loseMint = true;
    await expect(installProgramAgents(planSetup(root, ["claude_code"], { agentKeys: true }), 10, cms.api)).rejects.toMatchObject({ uncertainMint: true });
    expect(cms.rows).toHaveLength(1); expect(cms.requests.filter(req => req.method === "POST")).toHaveLength(1);
    expect(existsSync(join(root, ".affitor/agents/claude_code.json"))).toBe(false);
  });
  it("does not follow a mint redirect or resend a user JWT", async () => {
    const root = project(), cms = await fixture(); cms.behavior.redirectMint = true;
    await expect(installProgramAgents(planSetup(root, ["claude_code"], { agentKeys: true }), 10, cms.api)).rejects.toMatchObject({ uncertainMint: true });
    expect(cms.requests.filter(req => req.method === "POST")).toHaveLength(1);
    expect(cms.requests.some(req => req.path === "/mint-redirect-target")).toBe(false);
  });
  it("revokes an identifiable row from an invalid mint payload", async () => {
    const root = project(), cms = await fixture(); cms.behavior.invalidMint = true;
    await expect(installProgramAgents(planSetup(root, ["claude_code"], { agentKeys: true }), 10, cms.api)).rejects.toMatchObject({ cleanupIds: [], uncertainMint: false });
    expect(cms.rows[0].status).toBe("revoked");
  });
  it("rolls back private/config writes and revokes only this run's keys after local failure", async () => {
    const root = project(), cms = await fixture(); put(root, ".mcp.json", '{"keep":true}');
    const apply = (plan: ReturnType<typeof planSetup>) => applySetup(plan, action => { if (action.path.endsWith(".mcp.json")) throw new Error("fake fs failure"); });
    await expect(installProgramAgents(planSetup(root, ["claude_code"], { agentKeys: true }), 10, cms.api, apply)).rejects.toMatchObject({ cleanupIds: [], uncertainMint: false });
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe('{"keep":true}'); expect(existsSync(join(root, ".affitor/agents/claude_code.json"))).toBe(false);
    expect(cms.rows[0].status).toBe("revoked");
  });
  it("preserves a concurrent private-file edit and its ignore guards during rollback", async () => {
    const root = project(), cms = await fixture(); expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    const apply = (plan: ReturnType<typeof planSetup>) => applySetup(plan, action => {
      if (action.path.endsWith(".mcp.json")) { put(root, ".affitor/agents/claude_code.json", "fake_newer_private_edit"); throw new Error(); }
    });
    await expect(installProgramAgents(planSetup(root, ["claude_code"], { agentKeys: true }), 10, cms.api, apply)).rejects.toBeInstanceOf(AgentSetupError);
    expect(readFileSync(join(root, ".affitor/agents/claude_code.json"), "utf8")).toBe("fake_newer_private_edit");
    expect(spawnSync("git", ["-C", root, "check-ignore", ".affitor/agents/claude_code.json"]).status).toBe(0);
    expect(cms.rows[0].status).toBe("revoked");
  });
  it.each(["program", "origin", "tracked"])("rejects %s credential conflict before any HTTP", async conflict => {
    const root = project(), cms = await fixture(), record = stored(cms.origin);
    if (conflict === "program") record.program_id = 20;
    if (conflict === "origin") record.api_url = "https://other.example.test";
    put(root, ".affitor/agents/claude_code.json", JSON.stringify(record));
    if (conflict === "tracked") { expect(spawnSync("git", ["init", "-q", root]).status).toBe(0); expect(spawnSync("git", ["-C", root, "add", ".affitor/agents/claude_code.json"]).status).toBe(0); }
    await expect(installProgramAgents(planSetup(root, ["claude_code"], { agentKeys: true }), 10, cms.api)).rejects.toBeInstanceOf(AgentSetupError);
    expect(cms.requests).toHaveLength(0); expect(JSON.parse(readFileSync(join(root, ".affitor/agents/claude_code.json"), "utf8"))).toEqual(record);
  });
  it.skipIf(process.platform === "win32").each(["timeout", "spawn_error", "exit128", "exit2"])("blocks a %s Git check before HTTP or tracked credential writes", async failure => {
    const root = project(), cms = await fixture(), original = JSON.stringify(stored(cms.origin));
    put(root, ".affitor/agents/claude_code.json", original);
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    expect(spawnSync("git", ["-C", root, "add", ".affitor/agents/claude_code.json"]).status).toBe(0);
    const bin = join(root, "test-bin");
    const action = failure === "timeout" ? "setTimeout(()=>process.exit(0),10000)" : `process.exit(${failure === "exit128" ? 128 : 2})`;
    put(root, "test-bin/git", failure === "spawn_error" ? "#!/nonexistent/fixture/git-interpreter\n" : `#!${process.execPath}\nif(process.argv.includes('rev-parse'))process.stdout.write('true\\n');else{${action};}\n`);
    chmodSync(join(bin, "git"), 0o700); vi.stubEnv("PATH", bin);
    const result = await installProgramAgents(planSetup(root, ["claude_code"], { agentKeys: true }), 10, cms.api).catch(error => error);
    expect({ blocked: result instanceof AgentSetupError, requests: cms.requests.length, bytesUnchanged: readFileSync(join(root, ".affitor/agents/claude_code.json"), "utf8") === original }).toEqual({ blocked: true, requests: 0, bytesUnchanged: true });
    expect(doctor(root, ["claude_code"])[0].warnings).toContain("credential_check_failed");
  });
  it("doctor warns about tracked per-client secrets without touching the index", async () => {
    const root = project(), cms = await fixture(); await installProgramAgents(planSetup(root, ["claude_code"], { agentKeys: true }), 10, cms.api);
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    expect(spawnSync("git", ["-C", root, "add", "-f", ".affitor/agents/claude_code.json"]).status).toBe(0);
    const index = spawnSync("git", ["-C", root, "ls-files", "--stage"], { encoding: "utf8" }).stdout;
    expect(doctor(root, ["claude_code"])[0]).toMatchObject({ warnings: ["credential_tracked"], liveSession: "not_checked" });
    expect(spawnSync("git", ["-C", root, "ls-files", "--stage"], { encoding: "utf8" }).stdout).toBe(index);
  });
  it.each(["malformed", "hardlink", "backup"])("rejects %s private file before HTTP", async kind => {
    const root = project(), external = project(), cms = await fixture();
    put(root, ".affitor/agents/claude_code.json", kind === "malformed" ? "{fake_private_invalid" : JSON.stringify(stored(cms.origin)));
    if (kind === "hardlink") linkSync(join(root, ".affitor/agents/claude_code.json"), join(external, "shared.json"));
    if (kind === "backup") { const parent = ".affitor/backups/.affitor/agents"; mkdirSync(join(root, parent), { recursive: true }); put(external, "backup.json", "fake_backup"); symlinkSync(join(external, "backup.json"), join(root, parent, "claude_code.json.affitor.bak")); }
    expect(() => planSetup(root, ["claude_code"], { agentKeys: true })).toThrow();
    expect(cms.requests).toHaveLength(0);
  });
  it.skipIf(process.platform === "win32")("refuses private credentials with broad POSIX permissions", async () => {
    const root = project(), cms = await fixture(); put(root, ".affitor/agents/claude_code.json", JSON.stringify(stored(cms.origin)));
    chmodSync(join(root, ".affitor/agents/claude_code.json"), 0o644);
    expect(() => planSetup(root, ["claude_code"], { agentKeys: true })).toThrow("owner-only"); expect(cms.requests).toHaveLength(0);
  });
  it("rejects unsafe credential paths and pending direct apply before writes", async () => {
    const root = project(), external = project(); mkdirSync(join(root, ".affitor"));
    symlinkSync(external, join(root, ".affitor/agents"));
    expect(() => planSetup(root, ["claude_code"], { agentKeys: true })).toThrow();
    const other = project(); expect(() => applySetup(planSetup(other, ["claude_code"], { agentKeys: true }))).toThrow("not been prepared");
    expect(existsSync(join(other, ".affitor"))).toBe(false);
  });
});

describe("built command and generated launcher", () => {
  it("refuses an unconfigured local origin before HTTP or agent-file writes", async () => {
    const root = project(), cms = await fixture();
    vi.stubEnv("AFFITOR_AGENT_DEV_API_ORIGIN", "");
    const login = JSON.stringify({ token: "fixture_user_jwt", expires_at: "2099-01-01T00:00:00Z" });
    put(root, ".affitor/credentials.json", login);
    const result = await run(root, ["agent", "setup", "--client", "claude_code", "--program-id", "10", "--yes", "--json", "--api-url", cms.origin]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", revoke_failed_ids: [] });
    expect(result.stdout).not.toContain("fixture_user_jwt");
    expect(cms.requests).toHaveLength(0);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(root, ".affitor/agents"))).toBe(false);
    expect(readFileSync(join(root, ".affitor/credentials.json"), "utf8")).toBe(login);
  });
  it("dry-run/no consent/missing login never mint or write, and never print credentials", async () => {
    const root = project(), cms = await fixture(); put(root, ".affitor/config.json", '{"program_id":"10","api_key":"fake_legacy_key"}');
    for (const args of [["--dry-run"], [], ["--yes"]]) {
      const result = await run(root, ["agent", "setup", "--client", "claude_code", "--json", "--api-url", cms.origin, ...args]);
      expect(JSON.parse(result.stdout).status).toBe(args[0] === "--dry-run" ? "planned" : args[0] === "--yes" ? "needs_login" : "needs_confirmation");
      expect(result.stdout).not.toContain("fake_legacy_key"); expect(result.stdout).not.toContain("fake_inherited_live_key");
    }
    expect(cms.requests).toHaveLength(0); expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });
  it("uses saved login, reports only installed, and keeps secrets out of verbose JSON", async () => {
    const root = project(), cms = await fixture();
    put(root, ".affitor/credentials.json", JSON.stringify({ token: "fixture_user_jwt", expires_at: "2099-01-01T00:00:00Z" }));
    const result = await run(root, ["agent", "setup", "--client", "claude_code", "--program-id", "10", "--yes", "--json", "--verbose", "--api-url", cms.origin]);
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).status).toBe("needs_next_step");
    expect(result.stdout).not.toContain("fixture_user_jwt"); expect(result.stderr).not.toContain("fixture_user_jwt"); expect(result.stdout).not.toContain(key(201));
    expect(cms.requests.every(req => req.auth === "Bearer fixture_user_jwt")).toBe(true);
  });
  it.skipIf(process.platform === "win32")("launcher uses only its selected private credential, never inherited/application keys", async () => {
    const root = project(), cms = await fixture(); await installProgramAgents(planSetup(root, ["claude_code", "cursor"], { agentKeys: true }), 10, cms.api);
    put(root, "bin/npx", `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({key:process.env.AFFITOR_API_KEY,url:process.env.AFFITOR_API_URL,write:process.env.AFFITOR_MCP_WRITE}));`); chmodSync(join(root, "bin/npx"), 0o700);
    put(root, ".affitor/.env", "AFFITOR_API_KEY=fake_application_key\n");
    for (const [client, id] of [["claude_code", 201], ["cursor", 202]] as const) {
      const result = spawnSync(process.execPath, [join(root, ".affitor/agent-mcp.cjs"), client], { env: { ...cleanEnv, PATH: join(root, "bin"), AFFITOR_MCP_WRITE: "1" }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ key: key(id), url: cms.origin, write: "0" });
    }
    rmSync(join(root, ".affitor/agents/claude_code.json"));
    const missing = spawnSync(process.execPath, [join(root, ".affitor/agent-mcp.cjs"), "claude_code"], { env: cleanEnv, encoding: "utf8" });
    expect(missing.status).toBe(1); expect(missing.stdout).toBe("");
  });
  it.each(["http://example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test/?x=1"])("rejects unsafe API origin %s", value => {
    expect(() => agentApiOrigin(value)).toThrow(AgentSetupError);
  });
  it("still emits a standalone launcher without credential bytes", () => {
    expect(AGENT_LAUNCHER).not.toContain("fixture_user_jwt"); expect(AGENT_LAUNCHER).not.toContain(key(201));
  });
});
