import type { Command } from "commander";
import * as logger from "../lib/logger.js";
import { format } from "../lib/logger.js";
import { readConfig, ConfigNotFoundError } from "../lib/config.js";
import { getFlags } from "../lib/flags.js";
import type { CLIFlags } from "../types.js";

/**
 * Stripe is connected from the dashboard. The CLI flow this replaced could not work: its token
 * exchange needs Affitor's platform secret, the CMS endpoint that saved the connection answers
 * 410 Gone (W37-1690), and the webhook it created pointed at a URL the CMS does not serve.
 */
export const STRIPE_SETUP_MOVED =
  "Stripe is connected from the Affitor dashboard, not the CLI: open Affitor → Program settings → Payments and click Connect Stripe.";

export function registerSetupCommand(program: Command) {
  const setup = program
    .command("setup")
    .description("Set up integrations (stripe, dns)");

  setup
    .command("stripe")
    .description("Connect Stripe (points you to the dashboard)")
    .allowUnknownOption()
    .allowExcessArguments()
    .action((_opts, cmd) => {
      runSetupStripe(getFlags(cmd));
    });

  setup
    .command("dns")
    .description("Set up DNS CNAME tracking (coming soon)")
    .action(async (_opts, cmd) => {
      runSetupDns(getFlags(cmd));
    });
}

function runSetupStripe(flags: CLIFlags) {
  logger.error(STRIPE_SETUP_MOVED);
  if (flags.json) logger.json({ error: "stripe_setup_moved", message: STRIPE_SETUP_MOVED });
  process.exitCode = 1;
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

  logger.info(`  Get started: connect Stripe from the Affitor dashboard (Program settings → Payments, Connect Stripe).`);
  logger.newline();
}
