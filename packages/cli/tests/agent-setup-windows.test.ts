import { describe, expect, it, vi } from "vitest";
import { AgentSetupError, ProgramAgentClient, installProgramAgents } from "../src/lib/program-agent-client.js";
import { planSetup } from "../src/lib/agent-setup.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Runs on the real Windows CI worker, rather than mocking process.platform.
describe.skipIf(process.platform !== "win32")("Windows generated launcher smoke", () => {
  it("restricts user JWT origins and requires explicit local development configuration", () => {
    try {
      vi.stubEnv("AFFITOR_AGENT_DEV_API_ORIGIN", "");
      expect(new ProgramAgentClient("fixture_user_jwt", "https://api.affitor.com").origin).toBe("https://api.affitor.com");
      expect(() => new ProgramAgentClient("fixture_user_jwt", "https://untrusted.example.test")).toThrow(AgentSetupError);
      expect(() => new ProgramAgentClient("fixture_user_jwt", "http://127.0.0.1:1337")).toThrow(AgentSetupError);
      vi.stubEnv("AFFITOR_AGENT_DEV_API_ORIGIN", "http://127.0.0.1:1337");
      expect(new ProgramAgentClient("fixture_user_jwt", "http://127.0.0.1:1337").origin).toBe("http://127.0.0.1:1337");
      expect(() => new ProgramAgentClient("fixture_user_jwt", "http://127.0.0.1:1338")).toThrow(AgentSetupError);
      vi.stubEnv("AFFITOR_AGENT_DEV_API_ORIGIN", "https://untrusted.example.test");
      expect(() => new ProgramAgentClient("fixture_user_jwt", "https://untrusted.example.test")).toThrow(AgentSetupError);
    } finally { vi.unstubAllEnvs(); }
  });
  it("preserves an installed replacement when old-key revocation fails on the real filesystem", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "affitor-windows-replace-")));
    const api = new ProgramAgentClient("fixture_user_jwt", "https://api.affitor.com");
    const rows: { id: number; client: string; key_hint: string; status: string }[] = [];
    let next = 201;
    vi.spyOn(api, "list").mockResolvedValue(rows);
    vi.spyOn(api, "mint").mockImplementation(async (program_id, client) => {
      const id = next++, api_key = "aff_ag_" + String(id).padStart(43, "x");
      rows.push({ id, client, key_hint: `aff_ag_…${api_key.slice(-4)}`, status: "waiting" });
      return { version: 1, id, program_id, client, api_url: api.origin, api_key, created_at: "2026-10-18T00:00:00Z", credential_note: "Fake Windows fixture; not verified." };
    });
    const revoke = vi.spyOn(api, "revoke").mockRejectedValue(new Error("fixture revoke failure"));
    try {
      await installProgramAgents(planSetup(project, ["claude_code"], { agentKeys: true }), 10, api);
      rows[0].key_hint = "old-hint-format";
      await expect(installProgramAgents(planSetup(project, ["claude_code"], { agentKeys: true }), 10, api)).rejects.toMatchObject({ cleanupIds: [201], uncertainMint: false, message: expect.stringContaining("installed") });
      expect(JSON.parse(readFileSync(join(project, ".affitor/agents/claude_code.json"), "utf8")).id).toBe(202);
      expect(revoke).toHaveBeenCalledExactlyOnceWith(10, 201);
      expect(rows.map(row => row.status)).toEqual(["waiting", "waiting"]);
    } finally { vi.restoreAllMocks(); rmSync(project, { recursive: true, force: true }); }
  });
  it("ignores a cwd npx.cmd decoy and starts the PATH tool with a safe environment", () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "affitor-windows-")));
    const project = join(fixture, "project & (spaces) %NO_EXPAND%");
    const bin = join(project, "bin");
    mkdirSync(bin, { recursive: true });
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["path", "affitor_api_key", "affitor_api_url", "affitor_mcp_write", "nodefaultcurrentdirectoryinexepath", "claudecode", "codex", "codex_thread_id", "cursor_agent"].includes(key.toLowerCase())));
    env.PATH = bin;
    env.Affitor_Mcp_Write = "1";
    env.affitor_api_url = "https://wrong.invalid";
    env.NO_EXPAND = "wrong-path";
    env.NODE_OPTIONS = "--no-warnings";
    env.HTTPS_PROXY = "http://wrong.invalid";
    env.npm_config_registry = "https://wrong.invalid";
    const cli = resolve("dist/cli.js");
    try {
      const setup = spawnSync(process.execPath, [cli, "agent", "setup", "--client", "claude_code", "--yes", "--json"], { cwd: project, env, encoding: "utf8" });
      expect(setup.status, setup.stderr + setup.stdout).toBe(0);
      writeFileSync(join(project, ".affitor/.env"), "AFFITOR_API_KEY=fake_windows_key\r\n");
      writeFileSync(join(bin, "npx-fixture.cjs"), 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),key:process.env.AFFITOR_API_KEY,write:process.env.AFFITOR_MCP_WRITE,noCwd:process.env.NoDefaultCurrentDirectoryInExePath,unsafe:Object.keys(process.env).filter(k=>/^(https?_proxy|node_options|npm_config_registry)$/i.test(k)),overrides:Object.keys(process.env).filter(k=>k.toUpperCase()==="AFFITOR_API_URL"||k.toUpperCase()==="AFFITOR_MCP_WRITE")}));');
      writeFileSync(join(bin, "npx.cmd"), `@"${process.execPath}" "%~dp0npx-fixture.cjs" %*\r\n`);
      writeFileSync(join(project, "npx.cmd"), "@echo DECOY_CWD\r\n@exit /b 91\r\n");
      // Reproduce r1 on the same real Windows worker and the same fixture.
      const baseline = spawnSync("npx.cmd", ["-y", "@affitor/mcp@0.2.2"], { cwd: project, env, shell: false, encoding: "utf8", timeout: 15000 });
      expect(baseline.status).not.toBe(0);
      expect(baseline.error).toBeDefined();
      // The pre-hardening constant cmd command resolves the decoy from cwd.
      const unsafeLookup = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npx.cmd -y @affitor/mcp@0.2.2"], { cwd: project, env, encoding: "utf8", timeout: 15000 });
      expect(unsafeLookup.status, unsafeLookup.stderr + unsafeLookup.stdout).toBe(91);
      expect(unsafeLookup.stdout).toContain("DECOY_CWD");
      const launcher = spawnSync(process.execPath, [join(project, ".affitor/agent-mcp.cjs")], { cwd: fixture, env, encoding: "utf8", timeout: 15000 });
      expect(launcher.status, launcher.stderr + launcher.stdout).toBe(0);
      expect(JSON.parse(launcher.stdout)).toEqual({ args: ["--registry=https://registry.npmjs.org", "-y", "@affitor/mcp@0.2.2"], cwd: project, key: "fake_windows_key", write: "0", noCwd: "1", unsafe: [], overrides: ["AFFITOR_MCP_WRITE"] });
      const doctor = spawnSync(process.execPath, [cli, "doctor", "--client", "claude_code", "--json"], { cwd: project, env, encoding: "utf8" });
      // This fixture deliberately removes Git from PATH: unknown tracking is a warning.
      expect(doctor.status, doctor.stderr + doctor.stdout).toBe(1);
      expect(JSON.parse(doctor.stdout).clients[0].warnings).toEqual(["credential_check_failed"]);
      expect(JSON.parse(doctor.stdout).clients[0].credential).toBe("present_unverified");
      expect(existsSync(join(project, ".claude.json"))).toBe(false);
      expect(readFileSync(join(project, ".mcp.json"), "utf8")).not.toContain("fake_windows_key");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
  it("uses real Git to distinguish untracked and tracked credentials", () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "affitor-windows-git-")));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["claudecode", "codex", "codex_thread_id", "cursor_agent"].includes(key.toLowerCase())));
    const cli = resolve("dist/cli.js");
    try {
      expect(spawnSync("git", ["init", "-q", project]).status).toBe(0);
      const setup = spawnSync(process.execPath, [cli, "agent", "setup", "--client", "claude_code", "--yes", "--json"], { cwd: project, env, encoding: "utf8" });
      expect(setup.status, setup.stderr + setup.stdout).toBe(0);
      writeFileSync(join(project, ".affitor/.env"), "AFFITOR_API_KEY=fake_windows_key\r\n");
      const untracked = spawnSync(process.execPath, [cli, "doctor", "--client", "claude_code", "--json"], { cwd: project, env, encoding: "utf8" });
      expect(untracked.status, untracked.stderr + untracked.stdout).toBe(0);
      expect(JSON.parse(untracked.stdout).clients[0].warnings).toEqual([]);
      expect(spawnSync("git", ["-C", project, "add", "-f", ".affitor/.env"]).status).toBe(0);
      const tracked = spawnSync(process.execPath, [cli, "doctor", "--client", "claude_code", "--json"], { cwd: project, env, encoding: "utf8" });
      expect(tracked.status, tracked.stderr + tracked.stdout).toBe(1);
      expect(JSON.parse(tracked.stdout).clients[0].warnings).toEqual(["credential_tracked"]);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
  it("uses a selected private agent key instead of an inherited live key", () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "affitor-windows-agent-key-")));
    const project = join(fixture, "project & (spaces) %NO_EXPAND%"), bin = join(project, "bin");
    mkdirSync(bin, { recursive: true });
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["path", "claudecode", "codex", "codex_thread_id", "cursor_agent", "affitor_api_key", "affitor_api_url"].includes(key.toLowerCase())));
    env.PATH = bin;
    try {
      const setup = spawnSync(process.execPath, [resolve("dist/cli.js"), "agent", "setup", "--client", "claude_code", "--yes", "--json"], { cwd: project, env, encoding: "utf8" });
      expect(setup.status, setup.stderr).toBe(0);
      mkdirSync(join(project, ".affitor/agents"));
      const key = "aff_ag_" + "x".repeat(43);
      writeFileSync(join(project, ".affitor/agents/claude_code.json"), JSON.stringify({ version: 1, id: 1, program_id: 10, client: "claude_code", api_url: "https://api.affitor.com", api_key: key }));
      writeFileSync(join(bin, "npx-fixture.cjs"), 'process.stdout.write(JSON.stringify({key:process.env.AFFITOR_API_KEY,url:process.env.AFFITOR_API_URL,write:process.env.AFFITOR_MCP_WRITE}));');
      writeFileSync(join(bin, "npx.cmd"), `@"${process.execPath}" "%~dp0npx-fixture.cjs" %*\r\n`);
      env.AFFITOR_API_KEY = "fake_inherited_live_key"; env.Affitor_Api_Url = "https://wrong.invalid";
      const result = spawnSync(process.execPath, [join(project, ".affitor/agent-mcp.cjs"), "claude_code"], { cwd: fixture, env, encoding: "utf8", timeout: 15000 });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ key, url: "https://api.affitor.com", write: "0" });
      rmSync(join(project, ".affitor/agents/claude_code.json"));
      const missing = spawnSync(process.execPath, [join(project, ".affitor/agent-mcp.cjs"), "claude_code"], { env, encoding: "utf8", timeout: 15000 });
      expect(missing.status).toBe(1); expect(missing.stdout).toBe("");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
  it("refuses to print shell commands for Codex on Windows, including metacharacter paths", () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "affitor-windows-codex-")));
    const project = join(fixture, "project & echo INJECTED & rem (spaces) %NO_EXPAND% !EXPAND! 'quote'");
    mkdirSync(project);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["claudecode", "codex", "codex_thread_id", "cursor_agent"].includes(key.toLowerCase())));
    try {
      const setup = spawnSync(process.execPath, [resolve("dist/cli.js"), "agent", "setup", "--client", "codex", "--yes", "--json"], { cwd: project, env, encoding: "utf8" });
      expect(setup.status, setup.stderr + setup.stdout).toBe(0);
      const plan = JSON.parse(setup.stdout);
      // Negative control: the previous POSIX-only command executes a separator
      // on real cmd.exe. The fixture stub never invokes an actual Codex client.
      const stubBin = join(fixture, "bin");
      mkdirSync(stubBin);
      writeFileSync(join(stubBin, "codex.cmd"), "@echo CODEX_STUB\r\n");
      const legacyCommand = `codex mcp add affitor -- node '${plan.entry.args[0].replaceAll("'", "'\"'\"'")}'`;
      const baseline = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", legacyCommand], { cwd: fixture, env: { ...env, PATH: stubBin }, encoding: "utf8", timeout: 15000 });
      expect(baseline.stdout).toContain("INJECTED");
      expect(plan.manual).toHaveLength(1);
      expect(plan.manual[0]).toContain("No shell command is generated");
      expect(plan.manual[0]).not.toContain("codex mcp add");
      expect(plan.manual[0]).not.toContain(project);
      expect(plan.entry).toEqual({ command: "node", args: [join(project, ".affitor/agent-mcp.cjs")] });
      expect(plan.next).toContain("manual configuration instructions");
      expect(existsSync(plan.entry.args[0])).toBe(true);
      expect(existsSync(join(project, ".agents/skills/affitor/SKILL.md"))).toBe(true);
      expect(existsSync(join(project, ".codex/config.toml"))).toBe(false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

});
