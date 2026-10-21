import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { AgentSetupError } from "../lib/program-agent-client.js";
import { DraftClient, agentCredential, type DraftPayload } from "../lib/draft-client.js";

interface SetOptions {
  client?: string; file?: string; name?: string; website?: string; tagline?: string; description?: string;
  type?: string; rate?: string; months?: string;
}

/** Flags (or --file) → the draft payload. Validation is the server's; this only shapes the JSON. */
export function draftPayload(opts: SetOptions, readText: (path: string) => string = path => readFileSync(path, "utf8")): DraftPayload {
  if (opts.file) {
    const parsed = JSON.parse(readText(opts.file));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AgentSetupError("--file must hold one JSON object.");
    return parsed as DraftPayload;
  }
  const payload: DraftPayload = {};
  if (opts.name !== undefined) payload.name = opts.name;
  if (opts.website !== undefined) payload.website = opts.website;
  if (opts.tagline !== undefined) payload.tagline = opts.tagline;
  if (opts.description !== undefined) payload.description = opts.description;
  if (opts.type !== undefined || opts.rate !== undefined || opts.months !== undefined) {
    if (!opts.type || opts.rate === undefined) throw new AgentSetupError("A commission needs --type (one_time, recurring or lifetime) and --rate.");
    payload.commission = {
      type: opts.type as "one_time" | "recurring" | "lifetime",
      rate_pct: Number(opts.rate),
      ...(opts.months !== undefined ? { duration_months: Number(opts.months) } : {}),
    };
  }
  if (!Object.keys(payload).length) throw new AgentSetupError("Nothing to draft. Pass --name, --website, --tagline, --description, --type/--rate/--months or --file.");
  return payload;
}

function fail(error: unknown) {
  const message = error instanceof AgentSetupError ? error.message : error instanceof SyntaxError ? "--file is not valid JSON." : "The draft command could not finish.";
  process.stdout.write(JSON.stringify({ status: "error", message }) + "\n");
  process.exitCode = 1;
}

export function registerDraftCommands(program: Command) {
  const draft = program.command("draft").description("Propose business details and the commission as a draft an owner applies in one click");
  draft.command("show")
    .description("Show the open draft and what it would change")
    .option("--client <name>", "Which agent's key to use when several are set up")
    .action(async (opts: { client?: string }) => {
      try {
        const api = new DraftClient(agentCredential(process.cwd(), opts.client));
        process.stdout.write(JSON.stringify({ status: "ok", draft: await api.show(), apply_at: api.applyUrl() }, null, 2) + "\n");
      } catch (error) { fail(error); }
    });
  draft.command("set")
    .description("Write the draft (replaces the open one). Nothing changes until an owner or admin applies it")
    .option("--client <name>", "Which agent's key to use when several are set up")
    .option("--name <text>", "Program name")
    .option("--website <url>", "Website (http or https)")
    .option("--tagline <text>", "One-line tagline")
    .option("--description <text>", "Description")
    .option("--type <type>", "Commission type: one_time, recurring or lifetime")
    .option("--rate <percent>", "Commission rate in percent")
    .option("--months <n>", "Months a recurring commission pays (1-36)")
    .option("--file <path>", "A JSON object with the same fields instead of flags")
    .action(async (opts: SetOptions) => {
      try {
        const api = new DraftClient(agentCredential(process.cwd(), opts.client));
        const result = await api.set(draftPayload(opts));
        process.stdout.write(JSON.stringify({
          status: result ? "drafted" : "no_changes", draft: result,
          next: result ? `Ask an owner or admin to apply it in the dashboard: ${api.applyUrl()}` : "These values are already the program's settings.",
        }, null, 2) + "\n");
      } catch (error) { fail(error); }
    });
}
