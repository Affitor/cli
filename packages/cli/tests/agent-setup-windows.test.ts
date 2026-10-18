import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Runs on the real Windows CI worker, rather than mocking process.platform.
describe.skipIf(process.platform !== "win32")("Windows generated launcher smoke", () => {
  it("starts npx.cmd through cmd.exe with a metacharacter project path and no money tools", () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "affitor-windows-")));
    const project = join(fixture, "project & (spaces) %NO_EXPAND%");
    const bin = join(project, "bin");
    mkdirSync(bin, { recursive: true });
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["path", "affitor_api_key", "claudecode", "codex", "codex_thread_id", "cursor_agent"].includes(key.toLowerCase())));
    env.PATH = bin;
    env.AFFITOR_MCP_WRITE = "1";
    env.NO_EXPAND = "wrong-path";
    const cli = resolve("dist/cli.js");
    try {
      const setup = spawnSync(process.execPath, [cli, "agent", "setup", "--client", "claude_code", "--yes", "--json"], { cwd: project, env, encoding: "utf8" });
      expect(setup.status, setup.stderr + setup.stdout).toBe(0);
      writeFileSync(join(project, ".affitor/.env"), "AFFITOR_API_KEY=fake_windows_key\r\n");
      writeFileSync(join(bin, "npx-fixture.cjs"), 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),key:process.env.AFFITOR_API_KEY,write:process.env.AFFITOR_MCP_WRITE}));');
      writeFileSync(join(bin, "npx.cmd"), `@"${process.execPath}" "%~dp0npx-fixture.cjs" %*\r\n`);
      // Reproduce r1 on the same real Windows worker and the same fixture.
      const baseline = spawnSync("npx.cmd", ["-y", "@affitor/mcp@0.2.2"], { cwd: project, env, shell: false, encoding: "utf8", timeout: 15000 });
      expect(baseline.status).not.toBe(0);
      expect(baseline.error).toBeDefined();
      const launcher = spawnSync(process.execPath, [join(project, ".affitor/agent-mcp.cjs")], { cwd: fixture, env, encoding: "utf8", timeout: 15000 });
      expect(launcher.status, launcher.stderr + launcher.stdout).toBe(0);
      expect(JSON.parse(launcher.stdout)).toEqual({ args: ["-y", "@affitor/mcp@0.2.2"], cwd: project, key: "fake_windows_key", write: "0" });
      const doctor = spawnSync(process.execPath, [cli, "doctor", "--client", "claude_code", "--json"], { cwd: project, env, encoding: "utf8" });
      expect(doctor.status, doctor.stderr + doctor.stdout).toBe(0);
      expect(JSON.parse(doctor.stdout).clients[0].credential).toBe("present_unverified");
      expect(existsSync(join(project, ".claude.json"))).toBe(false);
      expect(readFileSync(join(project, ".mcp.json"), "utf8")).not.toContain("fake_windows_key");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});
