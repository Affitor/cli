import { applySetup, credentialWarnings, readPlannedAgentCredential, stageAgentCredential, type AgentClient, type SetupPlan } from "./agent-setup.js";
import type { StoredAgentCredential } from "./agent-launcher.js";

export class AgentSetupError extends Error {
  constructor(message: string, public readonly cleanupIds: number[] = [], public readonly uncertainMint = false) { super(message); }
}
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function rootOrigin(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !["https:", "http:"].includes(url.protocol)) throw new Error();
  return url;
}
export function agentApiOrigin(value: string): string {
  try {
    const url = rootOrigin(value);
    if (url.origin === "https://api.affitor.com") return url.origin;
    const development = process.env.AFFITOR_AGENT_DEV_API_ORIGIN;
    if (development && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && rootOrigin(development).origin === url.origin) return url.origin;
    throw new Error();
  } catch { throw new AgentSetupError("Agent setup sends login credentials only to https://api.affitor.com. Local development requires AFFITOR_AGENT_DEV_API_ORIGIN to match the exact loopback API origin."); }
}
interface AgentRow { id: number; client: string; key_hint: string; status: string; revoked_at?: string | null }

/** User JWT only. Mint is never retried: a lost response may already have created a row. */
export class ProgramAgentClient {
  readonly origin: string;
  constructor(private token: string, origin: string) {
    this.origin = agentApiOrigin(origin);
    if (!token || /^aff_|^agt_/.test(token)) throw new AgentSetupError("Sign in with affitor login before creating agent keys.");
  }
  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    try {
      const response = await fetch(this.origin + path, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new AgentSetupError(`Agent key request failed (HTTP ${response.status}). Check login, Owner access and the CMS release.`, [], method === "POST" && response.status >= 500);
      try { return await response.json(); }
      catch { throw new AgentSetupError("Agent key response could not be read.", [], method === "POST"); }
    } catch (error) {
      if (error instanceof AgentSetupError) throw error;
      throw new AgentSetupError("Agent key request did not complete. Check the API origin and connection.", [], method === "POST");
    }
  }
  async programs(): Promise<{ id: number; name: string }[]> {
    const result = await this.request("/api/v1/cli/programs");
    const rows = object(result) ? result.data : null;
    if (!Array.isArray(rows) || rows.some(row => !object(row) || !positive(row.id) || typeof row.name !== "string")) throw new AgentSetupError("Program list response is invalid.");
    return rows.map(row => ({ id: row.id, name: row.name.slice(0, 160).replace(/[\x00-\x1f\x7f]/g, "") }));
  }
  async list(programId: number): Promise<AgentRow[]> {
    const rows: AgentRow[] = []; let before: number | null = null;
    for (let page = 0; page < 100; page++) {
      const result = await this.request(`/api/v1/programs/${programId}/agents${before ? `?before=${before}` : ""}`);
      if (!object(result) || !Array.isArray(result.data) || result.data.length > 100 || !object(result.meta)) throw new AgentSetupError("Agent key list response is invalid.");
      for (const row of result.data) {
        if (!object(row) || !positive(row.id) || typeof row.client !== "string" || typeof row.key_hint !== "string" || typeof row.status !== "string" || !["waiting", "connected", "verified", "failing", "revoked"].includes(row.status)) throw new AgentSetupError("Agent key list response is invalid.");
        rows.push({ id: row.id, client: row.client, key_hint: row.key_hint, status: row.status, revoked_at: typeof row.revoked_at === "string" ? row.revoked_at : null });
      }
      const next = result.meta.next_cursor;
      if (next === null) return rows;
      if (!positive(next) || (before !== null && next >= before)) throw new AgentSetupError("Agent key pagination is invalid.");
      before = next;
    }
    throw new AgentSetupError("Agent key list is too large. Review credentials in the dashboard before retrying.");
  }
  async mint(programId: number, client: AgentClient): Promise<StoredAgentCredential> {
    const result = await this.request(`/api/v1/programs/${programId}/agents`, "POST", { name: client, client });
    const row = object(result) && object(result.data) ? result.data : null;
    if (!row || !positive(row.id) || row.client !== client || typeof row.api_key !== "string" || !/^aff_ag_[A-Za-z0-9_-]{43}$/.test(row.api_key)) {
      throw new AgentSetupError("Agent mint response is invalid. Review Waiting agents in the dashboard.", row && positive(row.id) ? [row.id] : [], !(row && positive(row.id)));
    }
    const created = new Date().toISOString();
    return { version: 1, id: row.id, program_id: programId, client, api_url: this.origin, created_at: created,
      credential_note: `Signed-in account; program ${programId}; ${client}; readiness/status/synthetic-test/click/test-only lead; created ${created}; not verified. Never commit this file.`,
      api_key: row.api_key };
  }
  async revoke(programId: number, id: number): Promise<void> {
    const result = await this.request(`/api/v1/programs/${programId}/agents/${id}`, "DELETE");
    if (!object(result) || !object(result.data) || result.data.revoked !== true) throw new AgentSetupError("Agent revocation could not be confirmed.");
  }
}

/** Prepare every client before local writes; compensate only keys minted by this run. */
export async function installProgramAgents(plan: SetupPlan, programId: number, api: ProgramAgentClient, apply: typeof applySetup = applySetup) {
  if (!positive(programId) || !plan.agentKeys || plan.agentKeys.length !== plan.clients.length) throw new AgentSetupError("Generate a fresh agent-key setup plan.");
  const existing = plan.clients.map(client => {
    const warnings = credentialWarnings(plan.project, `.affitor/agents/${client}.json`);
    if (warnings.includes("credential_tracked")) throw new AgentSetupError("A private agent credential is tracked by Git. Rotate it and resolve tracking/history before setup.");
    if (warnings.length) throw new AgentSetupError("Git credential tracking could not be checked. Resolve Git access and retry; no agent key was minted or files written.");
    const record = readPlannedAgentCredential(plan, client);
    if (record && (record.program_id !== programId || record.api_url !== api.origin)) throw new AgentSetupError("A selected agent belongs to another program or API origin. Revoke and remove that private credential before switching.");
    return { client, record };
  });
  // Only owner list reads: never call readiness/status to pretend a client connected.
  const rows = await api.list(programId), minted: number[] = [], replaced: number[] = [];
  try {
    for (const { client, record } of existing) {
      const row = record && rows.find(row => row.id === record.id && row.client === client);
      const active = row && row.status !== "revoked" && !row.revoked_at;
      const reusable = record && active && row.key_hint === `aff_ag_…${record.api_key.slice(-4)}`;
      const credential = reusable ? record : await api.mint(programId, client);
      if (!reusable) minted.push(credential.id);
      if (record && active && !reusable) replaced.push(record.id);
      stageAgentCredential(plan, client, credential, !reusable);
    }
    apply(plan);
  } catch (error) {
    const known = [...new Set([...minted, ...(error instanceof AgentSetupError ? error.cleanupIds : [])])];
    const failed: number[] = [];
    for (const id of known) { try { await api.revoke(programId, id); } catch { failed.push(id); } }
    const uncertain = error instanceof AgentSetupError && error.uncertainMint;
    throw new AgentSetupError(uncertain || failed.length
      ? "Setup did not finish. Review Waiting agents in the dashboard and revoke unused credentials before retrying. Local files/private backups may need recovery."
      : "Setup did not finish; newly minted credentials were revoked. Check local files/private backups before retrying.", failed, uncertain);
  }
  // Local installation has committed. Failure to retire an old key must not
  // compensate the new credentials that the client now uses.
  const failed: number[] = [];
  for (const id of new Set(replaced)) { try { await api.revoke(programId, id); } catch { failed.push(id); } }
  if (failed.length) throw new AgentSetupError("New agent credentials were installed, but previous keys could not be confirmed revoked. Review the reported old key ids in Settings → Agents before retrying.", failed);
  return plan.agentKeys.map(({ client, path, id, state }) => ({ client, path, id, state }));
}
