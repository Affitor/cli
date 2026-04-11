import type { Command } from "commander";
import * as logger from "../lib/logger.js";
import { format } from "../lib/logger.js";
import { readConfig, updateConfig, writeSecrets, readSecrets, ConfigNotFoundError } from "../lib/config.js";
import { runStripeOAuth, StripeOAuthError } from "../lib/stripe-oauth.js";
import { AffitorAPI, APIError, NetworkError } from "../lib/api-client.js";
import { getFlags } from "../lib/flags.js";
import type { CLIFlags } from "../types.js";

export function registerSetupCommand(program: Command) {
  const setup = program
    .command("setup")
    .description("Set up integrations (stripe, dns)");

  setup
    .command("stripe")
    .description("Connect Stripe for automatic payment tracking")
    .option("--stripe-client-id <id>", "Stripe Connect client ID override")
    .option("--stripe-secret-key <key>", "Stripe secret key (for webhook creation)")
    .action(async (opts, cmd) => {
      await runSetupStripe(opts, getFlags(cmd));
    });

  setup
    .command("dns")
    .description("Set up DNS CNAME tracking (coming soon)")
    .action(async (_opts, cmd) => {
      runSetupDns(getFlags(cmd));
    });
}

async function runSetupStripe(
  opts: {
    stripeClientId?: string;
    stripeSecretKey?: string;
  },
  flags: CLIFlags,
) {
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

  // Check if already connected via secrets or legacy config
  const secrets = readSecrets();
  if (secrets?.stripe_account_id || config.stripe_connected) {
    const accountId = secrets?.stripe_account_id ?? config.stripe_account_id;
    logger.warn("Stripe is already connected.");
    logger.info(`  Account: ${accountId}`);
    logger.info("  To reconnect, disconnect first via the dashboard.");
    if (flags.json) {
      logger.json({
        status: "already_connected",
        stripe_account_id: accountId,
      });
    }
    process.exit(0);
  }

  const clientId =
    opts.stripeClientId ??
    process.env.STRIPE_CONNECT_CLIENT_ID ??
    process.env.AFFITOR_STRIPE_CLIENT_ID;

  if (!clientId) {
    logger.error(
      "Stripe Connect client ID not configured.\n" +
        "  Set STRIPE_CONNECT_CLIENT_ID or AFFITOR_STRIPE_CLIENT_ID environment variable,\n" +
        "  or pass --stripe-client-id <id>.",
    );
    if (flags.json) logger.json({ error: "missing_stripe_client_id" });
    process.exit(1);
  }

  const stripeSecretKey =
    opts.stripeSecretKey ??
    process.env.STRIPE_SECRET_KEY ??
    process.env.AFFITOR_STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    logger.error(
      "Stripe secret key not configured.\n" +
        "  Set STRIPE_SECRET_KEY or AFFITOR_STRIPE_SECRET_KEY environment variable,\n" +
        "  or pass --stripe-secret-key <key>.",
    );
    if (flags.json) logger.json({ error: "missing_stripe_secret_key" });
    process.exit(1);
  }

  const apiUrl = flags.apiUrl ?? config.api_url;
  const webhookUrl = `${apiUrl}/webhooks/stripe/${config.program_id}`;

  try {
    const totalSteps = 3;
    logger.newline();

    const result = await runStripeOAuth({
      clientId,
      programId: config.program_id,
      webhookUrl,
      stripeSecretKey,
    });

    logger.progressStep(1, totalSteps, "Stripe authorized", true);

    const api = AffitorAPI.fromFlags(
      { apiKey: flags.apiKey, apiUrl },
    );

    const saveResult = await api.saveStripeConnection({
      program_id: config.program_id,
      stripe_user_id: result.stripe_user_id,
      webhook_endpoint_id: result.webhook_endpoint_id,
      webhook_secret: result.webhook_secret,
    });

    logger.progressStep(2, totalSteps, "Connection saved", true);

    // Update secrets with Stripe account ID
    const currentSecrets = readSecrets();
    if (currentSecrets) {
      writeSecrets({
        ...currentSecrets,
        stripe_account_id: result.stripe_user_id,
      });
    }

    // Update config (for backward compat)
    updateConfig({
      stripe_connected: true,
      stripe_account_id: result.stripe_user_id,
    });

    logger.progressStep(3, totalSteps, "Config updated", true);

    if (flags.json) {
      logger.json({
        status: "connected",
        stripe_account_id: result.stripe_user_id,
        webhook_endpoint_id: result.webhook_endpoint_id,
        charges_enabled: saveResult.charges_enabled,
        payouts_enabled: saveResult.payouts_enabled,
      });
      return;
    }

    const chargesIcon = saveResult.charges_enabled ? format.green("✓") : format.yellow("⚠");
    const payoutsIcon = saveResult.payouts_enabled ? format.green("✓") : format.yellow("⚠");

    logger.titledBox("Stripe Connected", [
      "",
      `  Account:   ${format.bold(result.stripe_user_id)}`,
      `  Charges:   ${chargesIcon} ${saveResult.charges_enabled ? "Enabled" : "Pending verification"}`,
      `  Payouts:   ${payoutsIcon} ${saveResult.payouts_enabled ? "Enabled" : "Pending verification"}`,
      "",
      `  ${format.bold("Webhooks auto-configured:")}`,
      `  ${format.green("✓")} customer.created          ${format.dim("→ lead tracking")}`,
      `  ${format.green("✓")} checkout.session.completed ${format.dim("→ sale tracking")}`,
      `  ${format.green("✓")} invoice.paid               ${format.dim("→ recurring commission")}`,
      `  ${format.green("✓")} charge.refunded            ${format.dim("→ auto clawback")}`,
      "",
    ]);

    logger.info(`  Test it: ${format.dim("$")} npx affitor test sale`);
    logger.newline();
  } catch (err) {
    if (err instanceof StripeOAuthError) {
      logger.error(err.message);
      if (flags.json) logger.json({ error: "stripe_oauth_error", message: err.message });
    } else if (err instanceof APIError) {
      logger.error(`API error: ${err.message}`);
      if (flags.json) logger.json({ error: "api_error", message: err.message });
    } else if (err instanceof NetworkError) {
      logger.error(err.message);
      if (flags.json) logger.json({ error: "network_error" });
    } else {
      logger.error(`Unexpected error: ${(err as Error).message}`);
      if (flags.json) logger.json({ error: "unexpected_error", message: (err as Error).message });
    }
    process.exit(1);
  }
}

function runSetupDns(flags: CLIFlags) {
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

  if (flags.json) {
    logger.json({
      status: "not_implemented",
      message: "DNS tracking setup coming soon. Use Stripe tracking for now.",
      cname: {
        type: "CNAME",
        name: `t.${config.domain}`,
        target: "track.affitor.com",
      },
    });
    return;
  }

  logger.titledBox("DNS Tracking", [
    "",
    `  ${format.yellow("Coming soon.")} For now, use Stripe tracking.`,
    "",
    `  When available, add this DNS record:`,
    "",
    `  Type:    ${format.cyan("CNAME")}`,
    `  Name:    ${format.cyan(`t.${config.domain}`)}`,
    `  Target:  ${format.cyan("track.affitor.com")}`,
    `  TTL:     ${format.dim("Auto (or 300)")}`,
    "",
  ]);

  logger.info(`  Get started: ${format.dim("$")} npx affitor setup stripe`);
  logger.newline();
}
