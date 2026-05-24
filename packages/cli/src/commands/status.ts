import type { Command } from "commander";
import * as logger from "../lib/logger.js";
import { format } from "../lib/logger.js";
import { readConfig, ConfigNotFoundError } from "../lib/config.js";
import { AffitorAPI, APIError, NetworkError } from "../lib/api-client.js";
import { getFlags } from "../lib/flags.js";
import type { CLIFlags } from "../types.js";

export function registerStatusCommand(program: Command) {
  program
    .command("status")
    .description("Show program health: DNS, Stripe, recent events")
    .action(async (_opts, cmd) => {
      await runStatus(getFlags(cmd));
    });
}

async function runStatus(flags: CLIFlags) {
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

  const api = AffitorAPI.fromFlags(
    { apiKey: flags.apiKey, apiUrl: flags.apiUrl ?? config.api_url },
  );

  try {
    const status = await api.getStatus(config.program_id);

    if (flags.json) {
      logger.json(status);
      return;
    }

    // Build integrations section
    const dnsStatus = status.dns_verified
      ? format.green("Verified")
      : format.yellow("Not configured");

    const stripeStatus = status.stripe_connected
      ? status.stripe_charges_enabled
        ? format.green("Connected")
        : format.yellow("Pending verification")
      : format.dim("Not connected");
    const stripeLabel = status.stripe_connected
      ? status.stripe_charges_enabled
        ? "ok"
        : "warn"
      : "error";

    // Find max for progress bars
    const events = status.recent_events;
    const maxEvent = Math.max(events.clicks_24h, events.leads_24h, events.sales_24h, 1);

    logger.banner();

    logger.titledBox(status.name, [
      `  ${format.dim(config.domain)}`,
      `  ${format.dim("ID:")} ${status.program_id}`,
      "",
      `  ${format.bold("Integrations")}`,
      `  DNS      ${status.dns_verified ? format.green("●") : format.yellow("●")} ${dnsStatus}`,
      `  Stripe   ${stripeLabel === "ok" ? format.green("●") : stripeLabel === "warn" ? format.yellow("●") : format.red("●")} ${stripeStatus}`,
      "",
      `  ${format.bold("Events")} ${format.dim("(24h)")}`,
      `  Clicks   ${logger.miniBar(events.clicks_24h, maxEvent, 12)}  ${format.bold(String(events.clicks_24h))}`,
      `  Leads    ${logger.miniBar(events.leads_24h, maxEvent, 12)}  ${format.bold(String(events.leads_24h))}`,
      `  Sales    ${logger.miniBar(events.sales_24h, maxEvent, 12)}  ${format.bold(String(events.sales_24h))}`,
      "",
      `  ${format.dim("Partners:")} ${format.bold(String(status.active_partners))}    ${format.dim("Pending:")} ${format.bold(String(status.pending_commissions))}`,
    ]);

    // Action hints
    if (!status.dns_verified) {
      logger.step(`DNS: Add CNAME  t.${config.domain} → track.affitor.com`);
    }
    if (!status.stripe_connected) {
      logger.step("Stripe: Run  npx affitor setup stripe");
    }
  } catch (err) {
    if (err instanceof APIError) {
      if (err.status === 401) {
        logger.error(
          "API key expired or invalid.\n" +
            "  Run `npx affitor init` to get a new API key.",
        );
      } else {
        logger.error(`API error: ${err.message}`);
      }
      if (flags.json) logger.json({ error: err.message, status: err.status });
    } else if (err instanceof NetworkError) {
      logger.error(err.message);
      if (flags.json) logger.json({ error: "network_error" });
    } else {
      logger.error(`Unexpected error: ${(err as Error).message}`);
      if (flags.json) logger.json({ error: "unexpected_error" });
    }
    process.exit(1);
  }
}
