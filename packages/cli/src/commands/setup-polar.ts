import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getRecipe,
  getWebhookRoute,
  POLAR_WEBHOOK_EVENTS,
  type WebhookRoute,
} from "@affitor/recipes";
import * as logger from "../lib/logger.js";
import { format } from "../lib/logger.js";
import {
  readConfig,
  updateConfig,
  readSecrets,
  writeSecrets,
  resolveApiKey,
  ConfigNotFoundError,
} from "../lib/config.js";
import {
  PolarAPI,
  PolarAPIError,
  POLAR_API_PROD,
  POLAR_API_SANDBOX,
  type PolarWebhookEndpoint,
} from "../lib/polar-api.js";
import { detectStack } from "../lib/stack-detect.js";
import { promptPolarToken } from "../lib/prompts.js";
import { getFlags } from "../lib/flags.js";
import type { CLIFlags } from "../types.js";

interface SetupPolarOpts {
  token?: string;
  sandbox?: boolean;
  url?: string;
}

/** A machine-readable step in the --json summary (mirrors onboard's shape). */
interface SetupStep {
  step: string;
  status: "ok" | "skipped" | "manual" | "already" | "failed";
  detail?: string;
}

export function registerSetupPolarCommand(setup: Command) {
  setup
    .command("polar")
    .description(
      "Connect Polar: create the webhook endpoint on your org + generate the Affitor glue route",
    )
    .option("--token <token>", "Polar Organization Access Token (or POLAR_ACCESS_TOKEN env)")
    .option("--sandbox", "Use the Polar sandbox environment (sandbox-api.polar.sh)", false)
    .option(
      "--url <url>",
      "Webhook delivery URL (default: https://<your domain>/api/polar/webhook)",
    )
    .action(async (opts: SetupPolarOpts, cmd) => {
      await runSetupPolar(opts, getFlags(cmd));
    });
}

async function runSetupPolar(opts: SetupPolarOpts, flags: CLIFlags) {
  const cwd = process.cwd();

  // ── Config (program identity) ──
  let config;
  try {
    config = readConfig();
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      logger.error(err.message);
      if (flags.json) logger.json({ error: "no_config" });
      process.exit(1);
    }
    throw err;
  }

  const environment = opts.sandbox ? "sandbox" : "production";
  const webhookUrl = opts.url ?? `https://${config.domain}/api/polar/webhook`;

  // ── Idempotent early-exit (mirrors `setup stripe`) ──
  // Same URL + same environment + a stored secret → nothing to do.
  const secrets = readSecrets();
  if (
    config.polar_connected &&
    config.polar_environment === environment &&
    config.polar_webhook_url === webhookUrl &&
    secrets?.polar_webhook_secret
  ) {
    logger.warn("Polar is already connected.");
    logger.info(`  Endpoint: ${config.polar_webhook_endpoint_id} (${environment})`);
    logger.info(`  Delivers to: ${webhookUrl}`);
    logger.info("  Re-run with --url to point somewhere else.");
    if (flags.json) {
      logger.json({
        status: "already_connected",
        environment,
        webhook_endpoint_id: config.polar_webhook_endpoint_id,
        webhook_url: webhookUrl,
      });
    }
    process.exit(0);
  }

  // ── Token (flag > env > prompt; agents must pass it explicitly) ──
  let token = opts.token ?? process.env.POLAR_ACCESS_TOKEN;
  if (!token && !flags.json && !flags.noInteractive) {
    token = await promptPolarToken(!!opts.sandbox);
  }
  if (!token) {
    logger.error(
      "Polar access token not provided.\n" +
        "  Pass --token <token> or set POLAR_ACCESS_TOKEN.\n" +
        "  Create an Organization Access Token in the Polar dashboard\n" +
        "  (Settings → Developers). Sandbox tokens are separate (--sandbox).",
    );
    if (flags.json) logger.json({ error: "missing_polar_token" });
    process.exit(1);
  }

  // POLAR_API_BASE is a test seam (mock server) — not documented in --help.
  const baseUrl =
    process.env.POLAR_API_BASE ?? (opts.sandbox ? POLAR_API_SANDBOX : POLAR_API_PROD);
  const polar = new PolarAPI(token, baseUrl);
  const steps: SetupStep[] = [];
  const totalSteps = 3;

  try {
    logger.newline();

    // ── (1) Create (or reuse) the webhook endpoint on the advertiser's org ──
    const { endpoint, created } = await ensureWebhookEndpoint(polar, webhookUrl);
    steps.push({
      step: "webhook_endpoint",
      status: created ? "ok" : "already",
      detail: `${endpoint.id} → ${webhookUrl} [${endpoint.events.join(", ")}]`,
    });
    logger.progressStep(1, totalSteps, created ? "Webhook endpoint created" : "Webhook endpoint reused", true);

    // ── (2) Persist the signing secret + connection state ──
    const secretStep = persistSecret(endpoint.secret, config.program_id, flags);
    steps.push(secretStep);

    updateConfig({
      polar_connected: true,
      polar_environment: environment,
      polar_webhook_endpoint_id: endpoint.id,
      polar_webhook_url: webhookUrl,
    });
    logger.progressStep(2, totalSteps, "Connection saved", true);

    // ── (3) Generate the glue route (new file only; --json never writes) ──
    const stack = detectStack(cwd);
    const route = getWebhookRoute(stack.framework, "polar");
    const routeStep = route
      ? writeGlueRoute(cwd, route, flags)
      : ({ step: "glue_route", status: "manual", detail: `framework=${stack.framework}: printed recipe` } as SetupStep);
    steps.push(routeStep);

    // The app runtime needs the secret too (the route reads POLAR_WEBHOOK_SECRET).
    const envStep = writeAppEnvVar(cwd, "POLAR_WEBHOOK_SECRET", endpoint.secret, flags);
    steps.push(envStep);
    logger.progressStep(3, totalSteps, "Glue route + env", true);

    // ── Summary ──
    if (flags.json) {
      logger.json({
        status: "connected",
        environment,
        webhook_endpoint_id: endpoint.id,
        webhook_url: webhookUrl,
        events: endpoint.events,
        // The secret is NOT echoed; it is written to .affitor/.env (gitignored).
        secret_persisted: secretStep.status === "ok" || secretStep.status === "already",
        steps,
        ...(route
          ? {
              route: {
                path: routeStep.detail?.startsWith("src/") ? routeStep.detail : route.path,
                source: route.source,
                deps: route.deps,
                env: route.env,
              },
            }
          : {}),
        next_actions: nextActions(route, routeStep, stack.framework),
      });
      return;
    }

    printSummary({ environment, webhookUrl, endpoint, route, routeStep, cwd });
  } catch (err) {
    if (err instanceof PolarAPIError) {
      logger.error(err.message);
      if (flags.json) logger.json({ error: "polar_api_error", status: err.status, message: err.message });
    } else {
      logger.error(`Unexpected error: ${(err as Error).message}`);
      if (flags.json) logger.json({ error: "unexpected_error", message: (err as Error).message });
    }
    process.exit(1);
  }
}

/**
 * Find an endpoint already delivering to `webhookUrl` (idempotent re-runs —
 * the list response includes the signing secret, so we can recover it), else
 * create one. An existing endpoint missing our events gets them PATCHed in
 * (union — never drops events the advertiser added for other purposes).
 */
async function ensureWebhookEndpoint(
  polar: PolarAPI,
  webhookUrl: string,
): Promise<{ endpoint: PolarWebhookEndpoint; created: boolean }> {
  const existing = (await polar.listWebhookEndpoints()).find((e) => e.url === webhookUrl);

  if (!existing) {
    const endpoint = await polar.createWebhookEndpoint({
      url: webhookUrl,
      events: [...POLAR_WEBHOOK_EVENTS],
    });
    return { endpoint, created: true };
  }

  const missing = POLAR_WEBHOOK_EVENTS.filter((e) => !existing.events.includes(e));
  if (missing.length === 0) return { endpoint: existing, created: false };

  const updated = await polar.updateWebhookEndpointEvents(existing.id, [
    ...existing.events,
    ...missing,
  ]);
  // PATCH responses include the (unchanged) secret; fall back to the listed one.
  return { endpoint: { ...updated, secret: updated.secret ?? existing.secret }, created: false };
}

/**
 * Store the signing secret in `.affitor/.env` (gitignored — never committed).
 * Merges into existing secrets; when no secrets file exists yet, creates one
 * with the resolved API key so `readSecrets` keeps working. If no API key can
 * be resolved at all, we don't write a broken file — the caller still gets the
 * secret via the app-env write + summary.
 */
function persistSecret(secret: string, programId: string, flags: CLIFlags): SetupStep {
  const existing = readSecrets();
  if (existing) {
    if (existing.polar_webhook_secret === secret) {
      return { step: "affitor_secret", status: "already", detail: ".affitor/.env" };
    }
    writeSecrets({ ...existing, polar_webhook_secret: secret });
    return { step: "affitor_secret", status: "ok", detail: ".affitor/.env" };
  }

  const apiKey = resolveApiKey({ apiKey: flags.apiKey });
  if (apiKey) {
    writeSecrets({ api_key: apiKey, program_id: String(programId), polar_webhook_secret: secret });
    return { step: "affitor_secret", status: "ok", detail: ".affitor/.env (created)" };
  }

  return {
    step: "affitor_secret",
    status: "manual",
    detail: "no .affitor/.env and no API key resolved — secret written to app env only",
  };
}

/**
 * Write the generated webhook route as a NEW file (never overwrites — an
 * existing file is the advertiser's payment code; `affitor onboard` handles
 * injecting into it). Honors the App Router living under `src/`. In --json
 * mode nothing is written (the route ships in the JSON for the agent to apply).
 */
function writeGlueRoute(cwd: string, route: WebhookRoute, flags: CLIFlags): SetupStep {
  const relPath = existsSync(join(cwd, "src", "app")) ? join("src", route.path) : route.path;
  const absPath = join(cwd, relPath);

  if (existsSync(absPath)) {
    const content = safeRead(absPath);
    if (content.includes("affitor.trackSale(")) {
      if (!flags.json) logger.step(`${relPath} already reports the sale — skipped`);
      return { step: "glue_route", status: "already", detail: relPath };
    }
    if (!flags.json) {
      logger.warn(`${relPath} exists but doesn't report the sale to Affitor.`);
      logger.step(`Run ${format.cyan("npx affitor onboard")} to inject the trackSale call.`);
    }
    return { step: "glue_route", status: "manual", detail: `${relPath} exists: run onboard to inject` };
  }

  if (flags.json) {
    return { step: "glue_route", status: "manual", detail: `${relPath}: json mode (route in payload)` };
  }

  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, route.source, "utf8");
  logger.success(`Created ${relPath}`);
  return { step: "glue_route", status: "ok", detail: relPath };
}

/**
 * Persist an env var into the app's `.env.local` / `.env` (the runtime needs
 * POLAR_WEBHOOK_SECRET). Mirrors onboard's writeApiKeyToEnv contract: never
 * overwrites a different existing value, never writes in --json mode.
 */
function writeAppEnvVar(cwd: string, name: string, value: string, flags: CLIFlags): SetupStep {
  const envName = existsSync(join(cwd, ".env.local")) ? ".env.local" : ".env";
  const envPath = join(cwd, envName);
  const line = `${name}=${value}`;

  let content = "";
  if (existsSync(envPath)) {
    content = safeRead(envPath);
    const existing = content.match(new RegExp(`^${name}=(.*)$`, "m"));
    if (existing) {
      if (existing[1].trim() === value) {
        if (!flags.json) logger.step(`${envName} already has ${name} — skipped`);
        return { step: "app_env", status: "already", detail: envName };
      }
      if (!flags.json) {
        logger.warn(`${envName} already has a different ${name} — left unchanged.`);
      }
      return { step: "app_env", status: "manual", detail: `${envName}: existing value kept` };
    }
  }

  if (flags.json) {
    return { step: "app_env", status: "manual", detail: `${envName}: json mode (no auto-edit)` };
  }

  const needsNewline = content.length > 0 && !content.endsWith("\n");
  writeFileSync(envPath, `${content}${needsNewline ? "\n" : ""}${line}\n`, "utf8");
  logger.success(`Wrote ${name} to ${envName}`);
  return { step: "app_env", status: "ok", detail: envName };
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Agent-facing follow-ups for the --json payload. */
function nextActions(
  route: WebhookRoute | null,
  routeStep: SetupStep,
  framework: string,
): string[] {
  const actions: string[] = [];
  if (route && routeStep.status === "manual" && routeStep.detail?.includes("json mode")) {
    actions.push(`Write route.source to ${routeStep.detail.split(":")[0]} (new file).`);
  }
  if (route && routeStep.detail?.includes("run onboard")) {
    actions.push("Run `affitor onboard` to inject trackSale into the existing route.");
  }
  if (route) {
    actions.push(`Install route deps if missing: npm i ${route.deps.join(" ")}`);
  } else {
    actions.push(
      `No generated route for framework=${framework} — follow the printed recipe / ` +
        "affitor_get_integration_plan(framework, 'polar', 's2s').",
    );
  }
  actions.push("Set POLAR_WEBHOOK_SECRET and AFFITOR_API_KEY in the app's runtime env.");
  actions.push("Verify: `affitor test sale`, then poll readiness until integration_verified.");
  return actions;
}

function printSummary(args: {
  environment: string;
  webhookUrl: string;
  endpoint: PolarWebhookEndpoint;
  route: WebhookRoute | null;
  routeStep: SetupStep;
  cwd: string;
}): void {
  const { environment, webhookUrl, endpoint, route, routeStep } = args;

  logger.titledBox("Polar Connected", [
    "",
    `  Environment: ${format.bold(environment)}`,
    `  Endpoint:    ${format.bold(endpoint.id)}`,
    `  Delivers to: ${format.cyan(webhookUrl)}`,
    "",
    `  ${format.bold("Events subscribed:")}`,
    `  ${format.green("✓")} order.paid      ${format.dim("→ sale + renewal tracking")}`,
    `  ${format.green("✓")} order.refunded  ${format.dim("→ auto clawback")}`,
    "",
    `  Signing secret saved to ${format.cyan(".affitor/.env")} ${format.dim("(gitignored)")}`,
    "",
  ]);

  if (route) {
    if (routeStep.status === "ok") {
      logger.info(`  Glue route created: ${format.green(routeStep.detail ?? route.path)}`);
      logger.info(`  Install its deps if missing: ${format.dim("$")} npm i ${route.deps.join(" ")}`);
    }
  } else {
    // No generated route for this framework — print the canonical snippets.
    const recipe = getRecipe("unknown", "polar", "s2s");
    const lines: string[] = ["", `  ${format.dim("1) At checkout creation — plant attribution metadata:")}`];
    for (const l of recipe.metadata.snippet.split("\n")) lines.push(`     ${format.cyan(l)}`);
    if (recipe.sale) {
      lines.push("", `  ${format.dim("2) In your order.paid webhook handler — report the sale:")}`);
      for (const l of recipe.sale.snippet.split("\n")) lines.push(`     ${format.cyan(l)}`);
    }
    lines.push("");
    logger.titledBox("Wire the webhook route (no generated route for this stack)", lines);
  }

  logger.newline();
  logger.info(`  Next: make sure your deploy env has ${format.cyan("POLAR_WEBHOOK_SECRET")} + ${format.cyan("AFFITOR_API_KEY")}.`);
  logger.info(`  Test it: ${format.dim("$")} npx affitor test sale`);
  logger.newline();
}
