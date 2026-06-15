import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { getRecipe, type Framework as RecipeFramework, type Mode } from "@affitor/recipes";
import * as logger from "../lib/logger.js";
import { format } from "../lib/logger.js";
import { getFlags } from "../lib/flags.js";
import { AffitorAPI, APIError, NetworkError } from "../lib/api-client.js";
import { resolveApiKey } from "../lib/config.js";
import { confirmAction } from "../lib/prompts.js";
import { detectStack, type Framework } from "../lib/stack-detect.js";
import { detectPaymentProvider } from "../lib/server-tracking.js";
import { detectStripeWebhook } from "../lib/webhook-detect.js";
import { injectStripeTrackSale } from "../lib/inject.js";
import { runInstallWizard } from "../lib/wizard.js";
import { DEFAULT_API_URL, type CLIFlags, type ReadinessResult, type TestChainStatus } from "../types.js";

interface OnboardOpts {
  apiKey?: string;
  interactive?: boolean;
  yes?: boolean;
}

/** A single machine-readable step in the --json summary. */
interface OnboardStep {
  step: string;
  status: "ok" | "skipped" | "manual" | "already" | "failed";
  detail?: string;
}

export function registerOnboardCommand(program: Command) {
  program
    .command("onboard")
    .description(
      "Wire Affitor into this app end-to-end: detect → install browser tracking → inject the Stripe sale call → verify.",
    )
    .option("--api-key <key>", "Program API key (overrides env / .affitor/.env)")
    .option("--yes", "Auto-confirm all diffs (apply without prompting)", false)
    .action(async (opts: OnboardOpts, cmd) => {
      await runOnboard(opts, getFlags(cmd));
    });
}

/** Map our stack-detect framework to the recipe registry's framework union. */
function toRecipeFramework(framework: Framework): RecipeFramework {
  // The two unions are intentionally identical; this is a typed pass-through.
  return framework as RecipeFramework;
}

async function runOnboard(opts: OnboardOpts, flags: CLIFlags) {
  const cwd = process.cwd();
  const interactive = !flags.noInteractive && opts.interactive !== false;
  // --yes (or the global --auto-confirm, or --no-interactive for agents)
  // applies diffs without prompting.
  const autoConfirm = !!opts.yes || flags.autoConfirm || flags.noInteractive;
  const apiUrl = flags.apiUrl ?? DEFAULT_API_URL;
  const steps: OnboardStep[] = [];

  // ── (a) Resolve API key + program ──
  const apiKey = resolveApiKey({ apiKey: opts.apiKey ?? flags.apiKey }, cwd);
  if (!apiKey) {
    logger.error(
      "No API key found. Pass --api-key, set AFFITOR_API_KEY, or run `affitor init` first.",
    );
    if (flags.json) logger.json({ error: "no_api_key" });
    process.exit(1);
  }

  const api = new AffitorAPI({ apiUrl, apiKey });

  if (!flags.json) {
    logger.banner();
    logger.titledBox("Onboard", [
      "",
      "  Wiring Affitor into your app end-to-end.",
      `  API key:  ${format.dim(logger.maskApiKey(apiKey))}`,
      "",
    ]);
  }

  // ── (b) Detect stack + payment provider ──
  const stack = detectStack(cwd);
  const provider = detectPaymentProvider(cwd);
  steps.push({
    step: "detect",
    status: "ok",
    detail: `framework=${stack.framework}, provider=${provider}`,
  });

  if (!flags.json) {
    logger.titledBox("Detected", [
      "",
      `  Framework:        ${stack.framework === "unknown" ? format.yellow("not detected") : format.green(stack.framework)}`,
      `  Payment provider: ${provider === "unknown" ? format.yellow("not detected") : format.green(provider)}`,
      "",
    ]);
  }

  // ── (c) Browser tracking — reuse init's wizard (install @affitor/sdk +
  // inject <AffitorTracker/> via diff-preview+confirm + scaffold lib/affitor.ts).
  // Skipped in --json mode (the wizard is interactive/printed output). ──
  if (!flags.json) {
    await runInstallWizard({ cwd, programId: "", apiUrl, autoConfirm });
    steps.push({ step: "browser_tracking", status: "ok", detail: "via install wizard" });
  } else {
    steps.push({ step: "browser_tracking", status: "skipped", detail: "json mode" });
  }

  // ── (d) Server payment tracking — the new auto-edit (DIFF + confirm). ──
  const saleStep = await wireServerSale({
    cwd,
    framework: stack.framework,
    provider,
    interactive,
    autoConfirm,
    json: flags.json,
  });
  steps.push(saleStep);

  // ── (f) Persist AFFITOR_API_KEY into .env / .env.local (diff-preview, never
  // overwrite an existing value). ──
  const envStep = writeApiKeyToEnv(cwd, apiKey, { autoConfirm, json: flags.json });
  steps.push(envStep);

  // ── (g) Verify loop: fire the chain, poll readiness. ──
  const verify = await runVerifyLoop(api, { apiKey, apiUrl, json: flags.json });

  // ── (h) Final summary. ──
  if (flags.json) {
    logger.json({
      program_id: verify.readiness?.program_id ?? null,
      steps,
      integration_verified: verify.integration_verified,
      ...(verify.blocker ? { blocker: verify.blocker } : {}),
      ...(verify.next_action ? { next_action: verify.next_action } : {}),
    });
    return;
  }

  if (verify.integration_verified) {
    logger.titledBox("Verified", [
      "",
      `  ${format.green("✓")} Integration verified — clicks, leads and sales are attributing.`,
      "",
    ]);
  } else {
    const lines = ["", `  ${format.yellow("⧗")} Not verified yet.`];
    if (verify.blocker) lines.push(`  Blocked on:  ${format.yellow(verify.blocker)}`);
    if (verify.next_action) lines.push(`  Next action: ${verify.next_action}`);
    lines.push("", `  Re-run ${format.cyan("affitor onboard")} after fixing the blocker.`, "");
    logger.titledBox("Almost there", lines);
  }
}

// ─── (d) Server-side sale wiring ─────────────────────────────────────

interface WireSaleArgs {
  cwd: string;
  framework: Framework;
  provider: string;
  interactive: boolean;
  autoConfirm: boolean;
  json: boolean;
}

/**
 * The safety-critical part: locate the Stripe webhook, run the PURE
 * `injectStripeTrackSale` transform, and:
 *   - `injected`      → show the DIFF and confirm before writing.
 *   - `already`       → no-op (idempotent).
 *   - `unrecognized`  → PRINT the exact patch (snippet + inject_target + file:line).
 *   - no webhook      → PRINT the full recipe.
 * NEVER auto-edits when the structure isn't cleanly recognized.
 */
async function wireServerSale(args: WireSaleArgs): Promise<OnboardStep> {
  const { cwd, framework, provider, interactive, autoConfirm, json } = args;

  // Only Stripe has the auto-edit path (the recipe's sale snippet is keyed to
  // the verified checkout.session.completed event object). Other providers →
  // print the recipe (no reliable inject site).
  // Use 's2s' mode so a sale snippet exists (Connect mode = metadata only).
  const mode: Mode = "s2s";
  const recipe = getRecipe(toRecipeFramework(framework), provider === "stripe" ? "stripe" : "unknown", mode);

  if (provider !== "stripe") {
    if (!json) {
      printRecipe(recipe, null, "Server-side sale (printed — review and add)");
    }
    return { step: "server_sale", status: "manual", detail: `provider=${provider}: printed recipe` };
  }

  const hook = detectStripeWebhook(cwd, framework);

  if (!hook) {
    if (!json) {
      printRecipe(recipe, null, "Stripe sale (no webhook found — add this where you verify webhooks)");
    }
    return { step: "server_sale", status: "manual", detail: "no webhook handler found: printed recipe" };
  }

  const fileAbs = join(cwd, hook.file);
  let original: string;
  try {
    original = readFileSync(fileAbs, "utf8");
  } catch {
    if (!json) printRecipe(recipe, hook, "Stripe sale (couldn't read the webhook file — add manually)");
    return { step: "server_sale", status: "manual", detail: `unreadable ${hook.file}: printed recipe` };
  }

  // Compute the import specifier from the webhook file's directory to the
  // scaffolded server client (lib/affitor.ts or src/lib/affitor.ts).
  // Mirror the path logic from wizard.ts: prefer src/lib when src/ exists.
  const clientDir = existsSync(join(cwd, "src")) ? join(cwd, "src", "lib") : join(cwd, "lib");
  const clientAbs = join(clientDir, "affitor.ts");
  const webhookDir = dirname(fileAbs);
  let importSpecifier = relative(webhookDir, clientAbs).replace(/\.ts$/, "");
  // Ensure POSIX separators and a leading ./ or ../
  importSpecifier = importSpecifier.replace(/\\/g, "/");
  if (!importSpecifier.startsWith(".")) importSpecifier = `./${importSpecifier}`;

  const saleSnippet = recipe.sale?.snippet ?? "";
  const result = injectStripeTrackSale(original, { saleSnippet, importSpecifier });

  if (result.status === "already") {
    if (!json) logger.step(`${hook.file} already reports the sale — skipped`);
    return { step: "server_sale", status: "already", detail: hook.file };
  }

  if (result.status === "unrecognized") {
    // NEVER force-edit payment code we can't place confidently — print the patch.
    if (!json) {
      logger.warn(
        `Found your Stripe webhook (${format.green(`${hook.file}:${hook.line}`)}) but couldn't place the sale call safely.`,
      );
      printRecipe(recipe, hook, "Add the sale call yourself (exact patch)");
    }
    return {
      step: "server_sale",
      status: "manual",
      detail: `unrecognized shape in ${hook.file}: printed patch`,
    };
  }

  // injected → DIFF + confirm before touching payment code.
  if (!json) {
    showDiff(hook.file, result.added);
  }
  const ok =
    json || autoConfirm || (interactive && (await confirmAction(`Apply this change to ${hook.file}?`)));
  if (!ok) {
    if (!json) {
      logger.step("Skipped. Add the sale call when ready:");
      printRecipe(recipe, hook, "Stripe sale (skipped — add manually)");
    }
    return { step: "server_sale", status: "skipped", detail: `${hook.file}: user declined` };
  }

  // In --json mode we never edit files (no diff was shown to confirm). Treat it
  // as a manual step so agents drive the edit explicitly.
  if (json) {
    return { step: "server_sale", status: "manual", detail: `${hook.file}: json mode (no auto-edit)` };
  }

  writeFileSync(fileAbs, result.content, "utf8");
  logger.success(`Injected affitor.trackSale into ${hook.file}`);
  return { step: "server_sale", status: "ok", detail: hook.file };
}

/**
 * (e) Always PRINT the metadata-propagation snippet — we never auto-edit the
 * checkout-session-create call (it can't be located reliably). Plus the sale
 * snippet + inject_target when a `hook` is known (the unrecognized/no-webhook
 * fallbacks). Pure printing — touches no files.
 */
function printRecipe(
  recipe: ReturnType<typeof getRecipe>,
  hook: { file: string; line: number; handlerHint: string } | null,
  title: string,
): void {
  const lines: string[] = [""];

  // (e) Metadata — ALWAYS printed, NEVER auto-edited.
  lines.push(`  ${format.dim("1) At checkout-session creation — plant attribution metadata:")}`);
  lines.push(`     ${format.dim(recipe.metadata.why)}`);
  for (const l of recipe.metadata.snippet.split("\n")) lines.push(`     ${format.cyan(l)}`);
  lines.push("");

  // Sale snippet + where to inject it.
  if (recipe.sale) {
    if (hook) {
      lines.push(`  ${format.dim(`2) Report the sale — in ${hook.file}:${hook.line}`)} ${format.dim(`(${hook.handlerHint})`)}`);
    } else {
      lines.push(`  ${format.dim(`2) Report the sale — ${recipe.sale.inject_target}:`)}`);
    }
    for (const l of recipe.sale.snippet.split("\n")) lines.push(`     ${format.cyan(l)}`);
    lines.push("");
  }

  lines.push(`  ${format.dim("Affitor never auto-edits your checkout/payment code — paste these in.")}`, "");
  logger.titledBox(title, lines);
}

function showDiff(file: string, added: string[]): void {
  logger.newline();
  logger.info(`  ${format.dim("Proposed change to")} ${format.cyan(file)}${format.dim(":")}`);
  for (const line of added) {
    logger.info(`    ${format.green("+ " + line)}`);
  }
  logger.newline();
}

// ─── (f) Write AFFITOR_API_KEY to .env / .env.local ──────────────────

/**
 * Persist the program key into the project's env file (.env.local preferred for
 * Next, else .env). NEVER overwrites an existing AFFITOR_API_KEY value; if a
 * different value is present we print a diff-style notice and leave it. Appends
 * a new line when absent (diff-preview, then confirm unless autoConfirm).
 */
function writeApiKeyToEnv(
  cwd: string,
  apiKey: string,
  opts: { autoConfirm: boolean; json: boolean },
): OnboardStep {
  const envName = existsSync(join(cwd, ".env.local")) ? ".env.local" : ".env";
  const envPath = join(cwd, envName);
  const line = `AFFITOR_API_KEY=${apiKey}`;

  let content = "";
  if (existsSync(envPath)) {
    content = readFileSync(envPath, "utf8");
    const existing = content.match(/^AFFITOR_API_KEY=(.*)$/m);
    if (existing) {
      if (existing[1].trim() === apiKey) {
        if (!opts.json) logger.step(`${envName} already has AFFITOR_API_KEY — skipped`);
        return { step: "env_key", status: "already", detail: envName };
      }
      // Different value present — NEVER overwrite a secret. Print a notice.
      if (!opts.json) {
        logger.warn(`${envName} already has a different AFFITOR_API_KEY — left unchanged.`);
        logger.step(`To use this key instead, set: ${line}`);
      }
      return { step: "env_key", status: "manual", detail: `${envName}: existing value kept` };
    }
  }

  // --json (non-interactive auto) mode never edits files — the no-auto-edit
  // contract. Report it as a manual step (mirrors wireServerSale's json branch)
  // instead of silently mutating the user's root .env/.env.local.
  if (opts.json) {
    return { step: "env_key", status: "manual", detail: `${envName}: json mode (no auto-edit)` };
  }

  logger.newline();
  logger.info(`  ${format.dim(`Add to ${envName}:`)}`);
  logger.info(`    ${format.green("+ " + line)}`);
  logger.newline();

  const needsNewline = content.length > 0 && !content.endsWith("\n");
  const block = `${needsNewline ? "\n" : ""}${line}\n`;
  writeFileSync(envPath, content + block, "utf8");
  if (!opts.json) logger.success(`Wrote AFFITOR_API_KEY to ${envName}`);
  return { step: "env_key", status: "ok", detail: envName };
}

// ─── (g) Verification loop ───────────────────────────────────────────

interface VerifyResult {
  integration_verified: boolean;
  blocker?: string | null;
  next_action?: string | null;
  readiness?: ReadinessResult;
}

const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 2000;
/** Cap the total backoff wait so a rate-limited chain can never hang forever. */
const MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fire the synthetic chain, then poll readiness up to POLL_ATTEMPTS times until
 * `integration_verified` (or a gate blocks). Honors 429: reads
 * `retry_after_seconds`, backs off (capped at MAX_BACKOFF_MS), and never hammers.
 */
async function runVerifyLoop(
  api: AffitorAPI,
  opts: { apiKey: string; apiUrl: string; json: boolean },
): Promise<VerifyResult> {
  if (!opts.json) {
    logger.titledBox("Verify", ["", "  Firing the synthetic click → lead → sale chain…", ""]);
  }

  // Fire the chain. On 429, back off once (capped) then continue to polling.
  try {
    const chain = await api.runVerificationChain({ apiKey: opts.apiKey, apiUrl: opts.apiUrl });
    if (chain.rate_limited) {
      const wait = Math.min((chain.retry_after_seconds ?? 5) * 1000, MAX_BACKOFF_MS);
      if (!opts.json) {
        logger.step(`Rate limited — backing off ${Math.ceil(wait / 1000)}s (won't hammer).`);
      }
      await sleep(wait);
    } else if (!opts.json && chain.verdict) {
      const v = chain.verdict;
      logger.step(
        `Chain: click ${tick(v.click)} · lead ${tick(v.lead)} · sale ${tick(v.sale)}`,
      );
    }
  } catch (err) {
    if (!opts.json) {
      const msg = err instanceof APIError || err instanceof NetworkError ? err.message : (err as Error).message;
      logger.warn(`Verification chain didn't run: ${msg}`);
    }
  }

  // Poll readiness until verified or a gate blocks.
  let last: ReadinessResult | undefined;
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    try {
      last = await api.getReadiness({ apiKey: opts.apiKey, apiUrl: opts.apiUrl });
    } catch (err) {
      if (!opts.json) {
        const msg = err instanceof APIError ? err.message : (err as Error).message;
        logger.step(`Readiness check failed (attempt ${attempt}/${POLL_ATTEMPTS}): ${msg}`);
      }
      await sleep(POLL_DELAY_MS);
      continue;
    }

    if (last.integration_verified) {
      return { integration_verified: true, readiness: last };
    }

    const gate = blockingGate(last);
    if (!opts.json && gate) {
      logger.step(`Gate "${gate.id}" not passed (attempt ${attempt}/${POLL_ATTEMPTS}).`);
    }

    if (attempt < POLL_ATTEMPTS) await sleep(POLL_DELAY_MS);
  }

  const gate = last ? blockingGate(last) : undefined;
  return {
    integration_verified: false,
    blocker: gate?.id ?? last?.blocker ?? null,
    next_action: gate?.next_action ?? null,
    readiness: last,
  };
}

/**
 * The first failing gate (the blocker). The CMS readiness payload reports the
 * id of the first failing gate at the top-level `blocker` field, and the gate
 * verdicts under the keyed `gates` object — so resolve via `gates[blocker]`
 * (NOT `gates.find`, which would throw: `gates` is an object, not an array).
 * Falls back to scanning the keyed gates for the first non-`pass` status.
 */
export function blockingGate(
  r: ReadinessResult,
): { id: string; next_action?: string } | undefined {
  const gates = r.gates;
  if (r.blocker) {
    return { id: r.blocker, next_action: gates?.[r.blocker]?.next_action };
  }
  if (gates) {
    for (const [id, gate] of Object.entries(gates)) {
      if (gate && gate.status !== "pass") {
        return { id, next_action: gate.next_action };
      }
    }
  }
  return undefined;
}

/**
 * Render a single chain-step verdict. The CMS returns a `TestChainStatus`
 * STRING per step — green ✓ ONLY when it is exactly `'attributed'`; an
 * unattributed/wrong_partner step is a hard fail (✗ + status), pending is ⧗.
 */
export function tick(v: TestChainStatus | undefined): string {
  if (v === "attributed") return format.green("✓");
  if (v === "pending" || v === undefined) return format.yellow("⧗");
  return `${format.red("✗")} ${format.dim(v)}`;
}
