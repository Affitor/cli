import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { applySetup, doctor, planSetup, selectedClients } from "../src/lib/agent-setup.js";
import { AGENT_LAUNCHER, parseProgramCredential } from "../src/lib/agent-launcher.js";

const fixtures: string[] = [];
function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "affitor-agent-test-")));
  fixtures.push(dir);
  return dir;
}
function put(dir: string, path: string, content: string) {
  const file = join(dir, path);
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, content);
}
const cleanEnv = { ...process.env, CLAUDECODE: "", CODEX: "", CODEX_THREAD_ID: "", CURSOR_AGENT: "", AFFITOR_API_KEY: "" };
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("selection and preflight", () => {
  it("never selects detected clients without an explicit choice", () => {
    expect(selectedClients([], {})).toEqual([]);
    expect(selectedClients([], { CLAUDECODE: "1" })).toEqual(["claude_code"]);
    expect(() => selectedClients(["cursor"], { CLAUDECODE: "1" })).toThrow("only configure itself");
    expect(() => selectedClients(["claude_code"], { CODEX_THREAD_ID: "fixture" })).toThrow("only configure itself");
    expect(() => selectedClients(["other"], {})).toThrow("Unknown client");
  });
  it.each(['{', '[]', '{"mcpServers":[]}', '{"mcpServers":null}'])("preflights every selected client before writing: %s", bad => {
    const dir = project();
    put(dir, ".mcp.json", '{"keep":true}');
    put(dir, ".cursor/mcp.json", bad);
    expect(() => planSetup(dir, ["claude_code", "cursor"])).toThrow();
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe('{"keep":true}');
    expect(existsSync(join(dir, ".affitor"))).toBe(false);
  });
  it.each([".mcp.json", ".cursor"])("rejects symlink targets and parents: %s", target => {
    const dir = project(), external = project();
    put(external, "mcp.json", "{}");
    symlinkSync(target === ".cursor" ? external : join(external, "mcp.json"), join(dir, target));
    expect(() => planSetup(dir, [target === ".cursor" ? "cursor" : "claude_code"])).toThrow();
    expect(readFileSync(join(external, "mcp.json"), "utf8")).toBe("{}");
  });
  it("rejects a dangling symlink", () => {
    const dir = project();
    symlinkSync(join(dir, "nonexistent"), join(dir, ".mcp.json"));
    expect(() => planSetup(dir, ["claude_code"])).toThrow();
  });
  it("does not re-encode an invalid UTF-8 config", () => {
    const dir = project(), bytes = Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]);
    writeFileSync(join(dir, ".mcp.json"), bytes);
    expect(() => planSetup(dir, ["claude_code"])).toThrow("UTF-8");
    expect(readFileSync(join(dir, ".mcp.json"))).toEqual(bytes);
  });
});

describe("local transaction", () => {
  it.each(["*\n!*.bak\n", "*\n!.mcp.json.affitor.bak\n", "*\n!*/\n"])("rejects backup guards that can unignore secrets", guard => {
    const dir = project();
    put(dir, ".mcp.json", '{"other":{"token":"fake_private"}}');
    put(dir, ".affitor/backups/.gitignore", guard);
    expect(() => planSetup(dir, ["claude_code"])).toThrow("only the '*' rule");
    expect(existsSync(join(dir, ".affitor/backups/.mcp.json.affitor.bak"))).toBe(false);
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe('{"other":{"token":"fake_private"}}');
  });
  it.each([false, true])("keeps credentials ignored despite negations (child=%s)", child => {
    const dir = project();
    expect(spawnSync("git", ["init", "-q", dir]).status).toBe(0);
    put(dir, ".gitignore", "/.affitor/.env\n!/.affitor/.env\n");
    if (child) put(dir, ".affitor/.gitignore", "!/.env\n");
    put(dir, ".affitor/.env", "AFFITOR_API_KEY=fake_gitignore_key\n");
    expect(spawnSync("git", ["-C", dir, "check-ignore", ".affitor/.env"]).status).toBe(1);
    applySetup(planSetup(dir, ["claude_code"]));
    expect(spawnSync("git", ["-C", dir, "check-ignore", ".affitor/.env"]).status).toBe(0);
    expect(readFileSync(join(dir, ".affitor/.env"), "utf8")).toBe("AFFITOR_API_KEY=fake_gitignore_key\n");
    expect(planSetup(dir, ["claude_code"]).actions.every(a => a.operation === "unchanged")).toBe(true);
  });
  it("preserves unrelated entries, backs up original bytes privately, sets0600 and is idempotent", () => {
    const dir = project(), original = '{ "mcpServers": {"other":{"env":{"TOKEN":"fake-private-value"}}}, "keep":123 }';
    put(dir, ".mcp.json", original);
    const plan = planSetup(dir, ["claude_code", "cursor"]);
    applySetup(plan);
    const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(config.keep).toBe(123);
    expect(config.mcpServers.other.env.TOKEN).toBe("fake-private-value");
    expect(config.mcpServers.affitor).toEqual({ command: "node", args: [join(dir, ".affitor/agent-mcp.cjs")] });
    const backup = join(dir, ".affitor/backups/.mcp.json.affitor.bak");
    expect(readFileSync(backup, "utf8")).toBe(original);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, ".mcp.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("/.affitor/backups/");
    expect(planSetup(dir, ["claude_code", "cursor"]).actions.every(a => a.operation === "unchanged")).toBe(true);
    expect(doctor(dir, ["claude_code"])[0]).toMatchObject({ status: "aligned", liveSession: "not_checked" });
  });
  it("restores prior files when a later write fails", () => {
    const dir = project();
    put(dir, ".mcp.json", '{"keep":true}');
    const plan = planSetup(dir, ["claude_code", "cursor"]);
    expect(() => applySetup(plan, a => { if (a.path.endsWith(".cursor/mcp.json")) throw new Error("fixture failure"); })).toThrow("rolled back");
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe('{"keep":true}');
    expect(existsSync(join(dir, ".claude/skills/affitor/SKILL.md"))).toBe(false);
    expect(existsSync(join(dir, ".affitor/agent-mcp.cjs"))).toBe(false);
    expect(readFileSync(join(dir, ".affitor/backups/.gitignore"), "utf8")).toBe("*\n");
    expect(spawnSync("git", ["init", "-q", dir]).status).toBe(0);
    expect(spawnSync("git", ["-C", dir, "check-ignore", ".affitor/backups/.mcp.json.affitor.bak"]).status).toBe(0);
  });
  it("preserves concurrent edits before apply", () => {
    const dir = project(), plan = planSetup(dir, ["claude_code"]);
    put(dir, ".mcp.json", '{"newer":true}');
    expect(() => applySetup(plan)).toThrow();
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe('{"newer":true}');
  });
  it("preserves a concurrent edit to an earlier written file during rollback", () => {
    const dir = project(), plan = planSetup(dir, ["claude_code"]);
    expect(() => applySetup(plan, a => {
      if (a.path.endsWith("SKILL.md")) { put(dir, ".mcp.json", '{"newer":true}'); throw new Error(); }
    })).toThrow("concurrent edit was preserved");
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe('{"newer":true}');
  });
  it("Codex stays manual and its shell command quotes unusual project paths", () => {
    const dir = project(), special = join(dir, "a'b$(echo bad)");
    mkdirSync(special);
    const plan = planSetup(special, ["codex"]);
    applySetup(plan);
    expect(plan.manual[0]).toContain("'\"'\"'");
    expect(existsSync(join(special, ".codex/config.toml"))).toBe(false);
    expect(existsSync(join(special, ".agents/skills/affitor/SKILL.md"))).toBe(true);
    expect(doctor(special, ["codex"])[0].status).toBe("manual");
  });
});

describe("built command", () => {
  const bin = resolve("dist/cli.js");
  const run = (dir: string, args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, env: { ...cleanEnv, HOME: dir, ...env }, encoding: "utf8" });
  it.each(['AFFITOR_API_KEY=""', "AFFITOR_API_KEY=one\nAFFITOR_API_KEY=two", "AFFITOR_API_KEY=\nAFFITOR_API_KEY=two", "AFFITOR_API_KEY=", "AFFITOR_API_KEY=''"])("doctor rejects a credential the launcher cannot use: %s", text => {
    const dir = project();
    expect(run(dir, ["agent", "setup", "--client", "claude_code", "--yes", "--json"]).status).toBe(0);
    put(dir, ".affitor/.env", text);
    const result = run(dir, ["doctor", "--client", "claude_code", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).clients[0]).toMatchObject({ status: "aligned", credential: "missing" });
    const launcher = spawnSync(process.execPath, [join(dir, ".affitor/agent-mcp.cjs")], { env: cleanEnv, encoding: "utf8" });
    expect(launcher.status).toBe(1);
    expect(launcher.stdout).toBe("");
  });
  it("dry-run and noninteractive no-consent do not write, JSON never contains existing secrets", () => {
    const dir = project();
    put(dir, ".mcp.json", '{"mcpServers":{"other":{"env":{"TOKEN":"fake-private-value"}}}}');
    const dry = run(dir, ["agent", "setup", "--client", "claude_code", "--dry-run", "--json"]);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout).status).toBe("planned");
    expect(dry.stdout).not.toContain("fake-private-value");
    const no = run(dir, ["agent", "setup", "--client", "claude_code", "--json"]);
    expect(no.status).toBe(1);
    expect(JSON.parse(no.stdout).status).toBe("needs_confirmation");
    expect(existsSync(join(dir, ".affitor"))).toBe(false);
  });
  it("real apply/doctor agree, with no global config and no connected claim", () => {
    const dir = project();
    const applied = run(dir, ["agent", "setup", "--client", "claude_code", "--yes", "--json"]);
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout).status).toBe("needs_human");
    expect(existsSync(join(dir, ".claude.json"))).toBe(false);
    const result = run(dir, ["doctor", "--client", "claude_code", "--json"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "static", clients: [{ status: "aligned", credential: "missing", liveSession: "not_checked" }] });
  });
});

describe("shared credential parser", () => {
  it("validates inherited credentials and preserves their priority without reading a file", () => {
    const read = () => { throw new Error("should not read"); };
    expect(parseProgramCredential("fake_env_key", read)).toBe("fake_env_key");
    expect(parseProgramCredential(" ", () => "AFFITOR_API_KEY=fake_file_key")).toBe(null);
    expect(parseProgramCredential("", () => "export AFFITOR_API_KEY='fake_file_key'\n")).toBe("fake_file_key");
  });
});

describe("real generated launcher without network", () => {
  function launch(dir: string, env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [join(dir, ".affitor/agent-mcp.cjs")], { cwd: tmpdir(), env: { ...cleanEnv, AFFITOR_MCP_WRITE: "1", AFFITOR_API_URL: "https://wrong.invalid", ...env, PATH: join(dir, "bin") }, encoding: "utf8" });
  }
  function install(dir: string) {
    put(dir, ".affitor/agent-mcp.cjs", AGENT_LAUNCHER);
    put(dir, "bin/npx", `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),key:process.env.AFFITOR_API_KEY,write:process.env.AFFITOR_MCP_WRITE,url:process.env.AFFITOR_API_URL??null,aliases:Object.keys(process.env).filter(k=>k.toUpperCase()==="AFFITOR_API_URL"||k.toUpperCase()==="AFFITOR_MCP_WRITE")}));\n`);
    chmodSync(join(dir, "bin/npx"), 0o700);
  }
  it("reads the project program key, pins MCP, fixes cwd and disables inherited money tools", () => {
    const dir = project(); install(dir);
    put(dir, ".affitor/.env", "# fixture only\nexport AFFITOR_API_KEY='fake_program_key'\n");
    const result = launch(dir);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: ["-y", "@affitor/mcp@0.2.2"], cwd: dir, key: "fake_program_key", write: "0", url: null, aliases: ["AFFITOR_MCP_WRITE"] });
  });
  it("removes mixed-case API overrides and write aliases before spawning MCP", () => {
    const dir = project(); install(dir);
    put(dir, ".affitor/.env", "AFFITOR_API_KEY=fake_file_key");
    const result = launch(dir, { affitor_api_url: "https://wrong.invalid", Affitor_Api_Url: "https://wrong2.invalid", affitor_mcp_write: "1" });
    expect(result.status, result.stderr).toBe(0);
    const child = JSON.parse(result.stdout);
    expect(child.url).toBe(null);
    expect(child.write).toBe("0");
    expect(child.aliases).toEqual(["AFFITOR_MCP_WRITE"]);
  });
  it("prefers an explicitly inherited program key", () => {
    const dir = project(); install(dir);
    put(dir, ".affitor/.env", "AFFITOR_API_KEY=fake_file_key");
    expect(JSON.parse(launch(dir, { AFFITOR_API_KEY: "fake_env_key" }).stdout).key).toBe("fake_env_key");
  });
  it.each(["", "AFFITOR_API_KEY=\"\"", "AFFITOR_API_KEY=one\nAFFITOR_API_KEY=two", 'AFFITOR_API_KEY=$(secret_command)'])("fails closed for missing/ambiguous key (%s)", content => {
    const dir = project(); install(dir);
    put(dir, ".affitor/.env", content);
    put(dir, ".affitor/credentials.json", '{"token":"fake_user_login_token"}');
    const result = launch(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("fake_user_login_token");
  });
});
