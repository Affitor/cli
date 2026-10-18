import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { AGENT_LAUNCHER, AGENT_SKILL, MCP_VERSION, parseProgramCredential, agentChildEnvironment, parseStoredAgentCredential, type StoredAgentCredential } from "./agent-launcher.js";

export const CLIENTS = ["claude_code", "cursor", "codex"] as const;
export type AgentClient = typeof CLIENTS[number];
type JsonObject = Record<string, unknown>;
export interface FileAction {
  path: string;
  operation: "create" | "update" | "unchanged";
  backup: string | null;
  // May include unrelated secrets from an existing config. Never serialize this field.
  content: string;
}
export interface SetupPlan {
  project: string;
  clients: AgentClient[];
  mcpVersion: string;
  entry: { command: string; args: string[] };
  actions: FileAction[];
  manual: string[];
  notes: string[];
  agentKeys?: { client: AgentClient; path: string; id?: number; state: "pending" | "reused" | "minted" }[];
}
const snapshots = new WeakMap<SetupPlan, Map<string, string | null>>();

export function object(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Refuse symlinks anywhere below the canonical project directory. */
function safePath(project: string, path: string) {
  const rel = relative(project, path);
  if (!rel || rel.startsWith("..") || resolve(project, rel) !== path) throw new Error("Unsafe setup target.");
  let current = project;
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    if (!existsSync(current)) {
      // existsSync follows symlinks, including dangling ones.
      try { if (lstatSync(current).isSymbolicLink()) throw new Error("Setup target is a symlink."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current === path ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
      throw new Error("Setup target must be a regular file with no symlink parents.");
    }
  }
}

function readTarget(project: string, path: string): string | null {
  safePath(project, path);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Setup target must contain valid UTF-8. Nothing was written.");
  return text;
}

function configFile(client: AgentClient) {
  return client === "claude_code" ? ".mcp.json" : ".cursor/mcp.json";
}

export function callerClient(env: NodeJS.ProcessEnv): AgentClient | undefined {
  if (env.CLAUDECODE) return "claude_code";
  if (env.CODEX || env.CODEX_THREAD_ID) return "codex";
  if (env.CURSOR_AGENT) return "cursor";
  return undefined;
}

export function selectedClients(names: string[], env: NodeJS.ProcessEnv): AgentClient[] {
  if (names.some(name => !CLIENTS.includes(name as AgentClient))) throw new Error("Unknown client. Choose claude_code, cursor or codex.");
  const caller = callerClient(env);
  if (caller && names.some(name => name !== caller)) throw new Error("An agent can only configure itself. Run setup in your own terminal for other clients.");
  return [...new Set(names.length ? names as AgentClient[] : caller ? [caller] : [])];
}

export function setupProgramId(cwd: string, explicit?: string): number | null {
  const valid = (value: unknown) => (typeof value === "number" || typeof value === "string") && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
  if (explicit !== undefined) {
    if (!valid(explicit)) throw new Error("Setup target program id must be a positive decimal integer.");
    return Number(explicit);
  }
  const project = realpathSync(resolve(cwd));
  const raw = readTarget(project, join(project, ".affitor/config.json"));
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Setup target project config is invalid. Resolve it before setup."); }
  if (!object(value) || !valid(value.program_id)) throw new Error("Setup target project config has no valid program id. Pass --program-id explicitly.");
  return Number(value.program_id);
}

export function planSetup(cwd: string, clients: AgentClient[], options: { agentKeys?: boolean } = {}): SetupPlan {
  const project = realpathSync(resolve(cwd));
  const launcher = join(project, ".affitor/agent-mcp.cjs");
  const entry = { command: "node", args: [launcher] };
  const plan: SetupPlan = { project, clients, entry, mcpVersion: MCP_VERSION, actions: [], manual: [], notes: clients.length ? ["MCP entries contain this machine's absolute project path. Keep configs local or regenerate them on each teammate's machine."] : [] };
  const before = new Map<string, string | null>();
  const add = (rel: string, content: string, expectedOriginal?: string | null) => {
    const path = join(project, rel);
    const original = readTarget(project, path);
    if (expectedOriginal !== undefined && original !== expectedOriginal) throw new Error("A setup file changed while planning. Run setup again.");
    const backup = original !== null && original !== content ? join(project, ".affitor/backups", `${rel}.affitor.bak`) : null;
    if (backup) {
      safePath(project, backup);
      // An earlier first snapshot stays intact; reject an unsafe backup, never overwrite it.
      if (existsSync(backup)) readTarget(project, backup);
    }
    before.set(path, original);
    plan.actions.push({ path, content, backup, operation: original === content ? "unchanged" : original === null ? "create" : "update" });
  };
  if (!options.agentKeys && clients.some(client => readTarget(project, join(project, `.affitor/agents/${client}.json`)) !== null)) {
    throw new Error("Setup target already has per-client credentials. Pass --program-id before updating.");
  }
  if (options.agentKeys) {
    plan.notes.push("Matching active keys are reused. Replacing an active selected key revokes its previous key after the new files are saved; failed revocations require dashboard cleanup.");
    plan.agentKeys = clients.map(client => {
      const rel = `.affitor/agents/${client}.json`;
      const path = join(project, rel), raw = readTarget(project, path);
      if (raw !== null && process.platform !== "win32" && (lstatSync(path).mode & 0o077) !== 0) throw new Error("Setup target private agent credential must have owner-only permissions.");
      if (raw !== null && !parseStoredAgentCredential(raw, client)) throw new Error("Setup target has an invalid private agent credential. Resolve it before retrying.");
      const backup = join(project, ".affitor/backups", `${rel}.affitor.bak`);
      safePath(project, backup); if (existsSync(backup)) readTarget(project, backup);
      add(rel, "", raw);
      return { client, path, state: "pending" };
    });
  }
  const editable = clients.filter(client => client !== "codex");
  for (const client of editable) {
    const rel = configFile(client);
    const path = join(project, rel);
    const raw = readTarget(project, path);
    let config: unknown;
    try { config = raw === null ? {} : JSON.parse(raw); }
    catch { throw new Error(`${rel} is not valid JSON. Nothing was written.`); }
    if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) {
      throw new Error(`${rel} must contain an object with an mcpServers object. Nothing was written.`);
    }
    const existingEntry = (config.mcpServers as JsonObject | undefined)?.affitor;
    if (!options.agentKeys && object(existingEntry) && Array.isArray(existingEntry.args) && existingEntry.args.includes(client)) throw new Error("Setup target uses per-client credentials. Pass --program-id before updating.");
    config.mcpServers = { ...(config.mcpServers as JsonObject | undefined), affitor: options.agentKeys ? { command: entry.command, args: [...entry.args, client] } : entry };
    add(rel, JSON.stringify(config, null, 2) + "\n", raw);
    add(client === "claude_code" ? ".claude/skills/affitor/SKILL.md" : ".cursor/skills/affitor/SKILL.md", AGENT_SKILL);
  }
  if (clients.includes("codex")) {
    if (process.platform === "win32") {
      // A path may contain cmd.exe expansion/separator characters. Do not emit
      // executable shell text when the invoking Windows shell is unknown.
      plan.manual.push('Windows: add Affitor in Codex MCP settings using command "node" and the exact arguments in entry.args plus codex when using per-client agent keys. No shell command is generated.');
    } else {
      plan.manual.push(`codex mcp add affitor -- node '${launcher.replaceAll("'", "'\"'\"'")}'${options.agentKeys ? ' codex' : ''}`);
    }
    // Installing a shared skill and launcher needs the same explicit consent.
    add(".agents/skills/affitor/SKILL.md", AGENT_SKILL);
  }
  if (clients.length) {
    add(".affitor/agent-mcp.cjs", AGENT_LAUNCHER);
    // The final matching rule wins at each directory level. Existing negations
    // must not cancel protection; a child guard also outranks root ignore rules.
    for (const [rel, entries] of [
      [".gitignore", ["/.affitor/.env", "/.affitor/backups/", "/.affitor/credentials.json", "/.affitor/agents/"]],
      [".affitor/.gitignore", ["/.env", "/backups/", "/credentials.json", "/agents/"]],
    ] as const) {
      const raw = readTarget(project, join(project, rel));
      const prior = raw ?? "";
      const suffix = entries.join("\n") + "\n";
      add(rel, prior.endsWith(suffix) ? prior : prior + (prior && !prior.endsWith("\n") ? "\n" : "") + suffix, raw);
    }
  }
  if (clients.length) {
    const guard = join(project, ".affitor/backups/.gitignore");
    const raw = readTarget(project, guard);
    if (raw !== null && !["*", "*\n", "*\r\n"].includes(raw)) throw new Error("Unsafe setup backup directory: its .gitignore must contain only the '*' rule.");
    add(".affitor/backups/.gitignore", raw ?? "*\n", raw);
    // Protect secret-containing backups before creating the first one. Keep this
    // guard with backups on rollback even if the root .gitignore is restored.
    plan.actions.unshift(plan.actions.pop()!);
  }
  if (options.agentKeys && clients.length) {
    const guard = ".affitor/agents/.gitignore", raw = readTarget(project, join(project, guard));
    if (raw !== null && !["*", "*\n", "*\r\n"].includes(raw)) throw new Error("Unsafe setup agent directory guard.");
    add(guard, raw ?? "*\n", raw);
    const action = plan.actions.pop()!;
    plan.actions.splice(1, 0, action);
  }
  snapshots.set(plan, before);
  return plan;
}

/** These APIs keep credential contents out of the public plan metadata. */
export function readPlannedAgentCredential(plan: SetupPlan, client: AgentClient): StoredAgentCredential | null {
  const path = plan.agentKeys?.find(item => item.client === client)?.path;
  if (!path) throw new Error("Setup plan does not include this agent credential.");
  const raw = snapshots.get(plan)?.get(path);
  return raw ? parseStoredAgentCredential(raw, client) : null;
}

export function stageAgentCredential(plan: SetupPlan, client: AgentClient, record: StoredAgentCredential, minted: boolean) {
  const item = plan.agentKeys?.find(item => item.client === client);
  if (!item || !parseStoredAgentCredential(JSON.stringify(record), client)) throw new Error("Setup agent credential is invalid.");
  const action = plan.actions.find(action => action.path === item.path)!;
  const original = snapshots.get(plan)!.get(item.path)!;
  action.content = minted ? JSON.stringify(record, null, 2) + "\n" : original!;
  action.operation = original === action.content ? "unchanged" : original === null ? "create" : "update";
  action.backup = original !== null && original !== action.content ? join(plan.project, ".affitor/backups", `.affitor/agents/${client}.json.affitor.bak`) : null;
  if (action.backup) { safePath(plan.project, action.backup); if (existsSync(action.backup)) readTarget(plan.project, action.backup); }
  item.id = record.id; item.state = minted ? "minted" : "reused";
}

function atomicWrite(project: string, path: string, content: string) {
  safePath(project, path);
  const guard = join(project, ".affitor/backups/.gitignore");
  // The guard bootstrap contains only '*'. Every later temp is protected before
  // merged config bytes reach disk, even if the process exits before finally.
  if (path !== guard) {
    const raw = readTarget(project, guard);
    if (raw === null || !["*", "*\n", "*\r\n"].includes(raw)) throw new Error("Unsafe setup temporary directory guard.");
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(project, ".affitor/backups", `.temporary-${randomUUID()}.tmp`);
  safePath(project, temporary);
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    safePath(project, path);
    renameSync(temporary, path);
    if (readFileSync(path, "utf8") !== content) throw new Error("Setup read-back failed.");
  } finally { rmSync(temporary, { force: true }); }
}

/** Local, synchronous transaction. It detects ordinary concurrent edits; it is not a local sandbox. */
export function applySetup(plan: SetupPlan, beforeWrite?: (action: FileAction) => void) {
  const before = snapshots.get(plan);
  if (plan.agentKeys?.some(item => item.state === "pending")) throw new Error("Setup agent credentials have not been prepared.");
  if (!before) throw new Error("Generate a fresh setup plan before applying it.");
  const applied: FileAction[] = [];
  let backupCreated = false;
  let privateWritten = false;
  try {
    for (const action of plan.actions) {
      if (readTarget(plan.project, action.path) !== before.get(action.path)) throw new Error("A setup file changed after planning. Run setup again.");
    }
    for (const action of plan.actions.filter(action => action.operation !== "unchanged")) {
      beforeWrite?.(action);
      if (readTarget(plan.project, action.path) !== before.get(action.path)) throw new Error("A setup file changed after planning. Run setup again.");
      if (action.backup && !existsSync(action.backup)) {
        const guard = readTarget(plan.project, join(plan.project, ".affitor/backups/.gitignore"));
        if (guard === null || !["*", "*\n", "*\r\n"].includes(guard)) throw new Error("Unsafe setup backup ignore guard.");
        safePath(plan.project, action.backup);
        mkdirSync(dirname(action.backup), { recursive: true });
        backupCreated = true;
        writeFileSync(action.backup, before.get(action.path)!, { flag: "wx", mode: 0o600 });
      }
      applied.push(action);
      if (plan.agentKeys?.some(item => item.path === action.path)) privateWritten = true;
      atomicWrite(plan.project, action.path, action.content);
    }
  } catch {
    let concurrent = false;
    for (const action of applied.reverse()) {
      // Never restore over a newer edit by somebody else.
      try {
        const original = before.get(action.path)!;
        const current = readTarget(plan.project, action.path);
        if ((backupCreated || privateWritten) && [join(plan.project, ".affitor/backups/.gitignore"), join(plan.project, ".affitor/agents/.gitignore")].includes(action.path) && original === null && current === action.content) continue;
        if (current === original) continue;
        if (current !== action.content) { concurrent = true; continue; }
        if (original === null) rmSync(action.path);
        else atomicWrite(plan.project, action.path, original);
      } catch { concurrent = true; }
    }
    throw new Error(concurrent ? "Setup failed; a concurrent edit was preserved. Check the files and private backups before retrying." : "Setup failed. Written files were rolled back; private backups were kept. Run a fresh dry-run.");
  }
}

/** No marker means Git really has nowhere to discover a worktree (GIT_* overrides are dropped). */
function hasGitAncestor(project: string): boolean | null {
  let current = project;
  for (;;) {
    try { lstatSync(join(current, ".git")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function credentialWarnings(project: string, relativePath = ".affitor/.env"): string[] {
  const env = agentChildEnvironment(process.env, "");
  delete env.AFFITOR_API_KEY;
  // Fixed locale permits only Git's exact no-repository result; other failures stay unknown.
  env.LC_ALL = "C";
  const run = (args: string[]) => spawnSync("git", ["-C", project, ...args], { env, encoding: "utf8", timeout: 1500, windowsHide: true });
  const discovery = run(["rev-parse", "--is-inside-work-tree"]);
  const failed = ["credential_check_failed"];
  if (discovery.error || discovery.signal) return failed;
  if (discovery.status === 128) {
    const noRepository = /^fatal: not a git repository \(or any of the parent directories\): \.git\r?\n?$/.test(discovery.stderr ?? "");
    return noRepository && discovery.stdout === "" && hasGitAncestor(project) === false ? [] : failed;
  }
  if (discovery.status !== 0 || discovery.stdout.trim() !== "true") return failed;
  const checked = run(["ls-files", "--error-unmatch", "--", relativePath]);
  if (checked.error || checked.signal) return failed;
  if (checked.status === 0) return ["credential_tracked"];
  return checked.status === 1 ? [] : failed;
}

export function doctor(cwd: string, clients: AgentClient[]) {
  return clients.map(client => {
    try {
      const root = realpathSync(resolve(cwd));
      const privatePath = join(root, `.affitor/agents/${client}.json`);
      const rawConfig = client === "codex" ? null : readTarget(root, join(root, configFile(client)));
      const entry = rawConfig ? JSON.parse(rawConfig)?.mcpServers?.affitor : null;
      const perClient = existsSync(privatePath) || (Array.isArray(entry?.args) && entry.args.includes(client));
      const plan = planSetup(cwd, [client], { agentKeys: perClient });
      const saved = perClient ? readPlannedAgentCredential(plan, client) : null;
      if (saved) stageAgentCredential(plan, client, saved, false);
      const keyPath = join(plan.project, ".affitor/.env");
      const credential = perClient ? saved?.api_key : parseProgramCredential(process.env.AFFITOR_API_KEY, () => {
        const stat = lstatSync(keyPath);
        return stat.isFile() && !stat.isSymbolicLink() ? readFileSync(keyPath, "utf8") : null;
      });
      return { client, warnings: credentialWarnings(plan.project, perClient ? `.affitor/agents/${client}.json` : ".affitor/.env"), notes: plan.notes, status: client === "codex" ? "manual" : plan.actions.some(a => a.operation === "create") ? "missing" : plan.actions.some(a => a.operation === "update") ? "stale" : "aligned", credential: credential ? "present_unverified" : "missing", liveSession: "not_checked", manual: plan.manual };
    } catch { return { client, warnings: [], notes: [], status: "invalid", credential: "not_checked", liveSession: "not_checked", manual: [] }; }
  });
}
