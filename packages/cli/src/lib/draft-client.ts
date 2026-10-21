import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENTS, type AgentClient } from "./agent-setup.js";
import { parseStoredAgentCredential, type StoredAgentCredential } from "./agent-launcher.js";
import { AgentSetupError, agentApiOrigin } from "./program-agent-client.js";

/** What an agent may put in a settings draft (spec 2026-10-20 agent draft §3.1). */
export interface DraftPayload {
  name?: string; website?: string; tagline?: string | null; description?: string;
  commission?: { type: "one_time" | "recurring" | "lifetime"; rate_pct: number; duration_months?: number | null };
}
export interface Draft { id: number; revision: number; payload_hash: string; status: string; payload: DraftPayload; changes: { field: string; from: unknown; to: unknown }[]; stale_fields: string[] }

const DRAFT_ERRORS: Record<string, string> = {
  unauthorized: "This agent key cannot write drafts. Create a key in Setup → Tracking → With AI (it carries the draft permission).",
  program_not_draft: "This program is live. Drafts are only for setup; change settings in the dashboard.",
  draft_changed: "The draft changed since you read it. Run affitor draft show and try again.",
  revision_required: "A draft is already open. Run affitor draft show and try again.",
  draft_budget: "Too many draft writes for this program this hour. Try again later.",
  validation_failed: "Some fields are not valid.",
};

/** The agent credential `affitor agent setup` saved for this project: --client, or the only one there is. */
export function agentCredential(cwd: string, client?: string): StoredAgentCredential {
  const candidates = (client ? [client] : [...CLIENTS]).filter(c => (CLIENTS as readonly string[]).includes(c) && existsSync(join(cwd, ".affitor/agents", `${c}.json`)));
  if (candidates.length !== 1) {
    throw new AgentSetupError(candidates.length ? "More than one agent is set up here. Pass --client claude_code, cursor or codex." : "No agent key in this project. Run affitor agent setup --code <code> first.");
  }
  const record = parseStoredAgentCredential(readFileSync(join(cwd, ".affitor/agents", `${candidates[0]}.json`), "utf8"), candidates[0] as AgentClient);
  if (!record) throw new AgentSetupError("The saved agent key is not valid. Run affitor agent setup again.");
  return record;
}

export class DraftClient {
  private origin: string;
  constructor(private credential: StoredAgentCredential) { this.origin = agentApiOrigin(credential.api_url); }
  private async request(method: "GET" | "PUT", body?: unknown): Promise<Draft | null> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}/api/v1/programs/${this.credential.program_id}/draft`, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.credential.api_key}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new AgentSetupError("The draft request did not complete. Check the connection and try again."); }
    let result: any = null;
    try { result = await response.json(); } catch { /* checked below */ }
    if (!response.ok) {
      const code = typeof result?.error?.code === "string" ? result.error.code : "";
      const fields = result?.error?.fields && typeof result.error.fields === "object" ? ` ${Object.entries(result.error.fields).map(([k, v]) => `${k}: ${String(v)}`).join("; ")}` : "";
      throw new AgentSetupError((DRAFT_ERRORS[code] ?? `Draft request failed (HTTP ${response.status}).`) + fields);
    }
    if (!result || typeof result !== "object" || !("draft" in result)) throw new AgentSetupError("Draft response is invalid.");
    return result.draft as Draft | null;
  }
  show() { return this.request("GET"); }
  /** Replaces the open draft (the one just read) or opens a new one. */
  async set(payload: DraftPayload) {
    const current = await this.show();
    return this.request("PUT", current ? { payload, draft_id: current.id, revision: current.revision } : { payload });
  }
  applyUrl() { return `https://affitor.com/brand/setup/business?programId=${this.credential.program_id}`; }
}
