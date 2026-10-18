import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_LAUNCHER, AGENT_SKILL, MCP_VERSION, parseProgramCredential } from "./agent-launcher.js";

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

export function planSetup(cwd: string, clients: AgentClient[]): SetupPlan {
  const project = realpathSync(resolve(cwd));
  const launcher = join(project, ".affitor/agent-mcp.cjs");
  const entry = { command: "node", args: [launcher] };
  const plan: SetupPlan = { project, clients, entry, mcpVersion: MCP_VERSION, actions: [], manual: [] };
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
    config.mcpServers = { ...(config.mcpServers as JsonObject | undefined), affitor: entry };
    add(rel, JSON.stringify(config, null, 2) + "\n", raw);
    add(client === "claude_code" ? ".claude/skills/affitor/SKILL.md" : ".cursor/skills/affitor/SKILL.md", AGENT_SKILL);
  }
  if (clients.includes("codex")) {
    plan.manual.push(`codex mcp add affitor -- node '${launcher.replaceAll("'", "'\"'\"'")}'`);
    // Installing a shared skill and launcher needs the same explicit consent.
    add(".agents/skills/affitor/SKILL.md", AGENT_SKILL);
  }
  if (clients.length) {
    add(".affitor/agent-mcp.cjs", AGENT_LAUNCHER);
    const path = join(project, ".gitignore");
    const raw = readTarget(project, path);
    const prior = raw ?? "";
    const entries = ["/.affitor/.env", "/.affitor/backups/"];
    const missing = entries.filter(line => !prior.split(/\r?\n/).includes(line));
    add(".gitignore", missing.length ? prior + (prior && !prior.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n" : prior, raw);
  }
  if (plan.actions.some(action => action.backup)) {
    const guard = join(project, ".affitor/backups/.gitignore");
    const raw = readTarget(project, guard);
    if (raw !== null && !["*", "*\n", "*\r\n"].includes(raw)) throw new Error("Unsafe setup backup directory: its .gitignore must contain only the '*' rule.");
    add(".affitor/backups/.gitignore", raw ?? "*\n", raw);
    // Protect secret-containing backups before creating the first one. Keep this
    // guard with backups on rollback even if the root .gitignore is restored.
    plan.actions.unshift(plan.actions.pop()!);
  }
  snapshots.set(plan, before);
  return plan;
}

function atomicWrite(project: string, path: string, content: string) {
  safePath(project, path);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.affitor-${randomUUID()}.tmp`;
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
  if (!before) throw new Error("Generate a fresh setup plan before applying it.");
  const applied: FileAction[] = [];
  let backupCreated = false;
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
      atomicWrite(plan.project, action.path, action.content);
    }
  } catch {
    let concurrent = false;
    for (const action of applied.reverse()) {
      // Never restore over a newer edit by somebody else.
      try {
        const original = before.get(action.path)!;
        const current = readTarget(plan.project, action.path);
        if (backupCreated && action.path === join(plan.project, ".affitor/backups/.gitignore") && original === null && current === action.content) continue;
        if (current === original) continue;
        if (current !== action.content) { concurrent = true; continue; }
        if (original === null) rmSync(action.path);
        else atomicWrite(plan.project, action.path, original);
      } catch { concurrent = true; }
    }
    throw new Error(concurrent ? "Setup failed; a concurrent edit was preserved. Check the files and private backups before retrying." : "Setup failed. Written files were rolled back; private backups were kept. Run a fresh dry-run.");
  }
}

export function doctor(cwd: string, clients: AgentClient[]) {
  return clients.map(client => {
    try {
      const plan = planSetup(cwd, [client]);
      const keyPath = join(plan.project, ".affitor/.env");
      const credential = parseProgramCredential(process.env.AFFITOR_API_KEY, () => {
        const stat = lstatSync(keyPath);
        return stat.isFile() && !stat.isSymbolicLink() ? readFileSync(keyPath, "utf8") : null;
      });
      return { client, status: client === "codex" ? "manual" : plan.actions.some(a => a.operation === "create") ? "missing" : plan.actions.some(a => a.operation === "update") ? "stale" : "aligned", credential: credential ? "present_unverified" : "missing", liveSession: "not_checked", manual: plan.manual };
    } catch { return { client, status: "invalid", credential: "not_checked", liveSession: "not_checked", manual: [] }; }
  });
}
