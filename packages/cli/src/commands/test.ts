import type { Command } from "commander";
import * as logger from "../lib/logger.js";
import { format } from "../lib/logger.js";
import { readConfig, ConfigNotFoundError } from "../lib/config.js";
import { AffitorAPI, APIError, NetworkError } from "../lib/api-client.js";
import { getFlags } from "../lib/flags.js";
import type { CLIFlags } from "../types.js";

export function registerTestCommand(program: Command) {
  program
    .command("test [event-type]")
    .description("Send a test event (click, lead, or sale)")
    .action(async (eventType: string | undefined, _opts, cmd) => {
      await runTest(eventType, getFlags(cmd));
    });
}

async function runTest(eventType: string | undefined, flags: CLIFlags) {
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

  const validTypes = ["click", "lead", "sale"] as const;
  type EventType = (typeof validTypes)[number];

  const type: EventType = (eventType as EventType) ?? "click";

  if (!validTypes.includes(type)) {
    logger.error(
      `Invalid event type: "${eventType}".\n` +
        "  Valid types: click, lead, sale\n" +
        "  Example: npx affitor test sale",
    );
    if (flags.json) logger.json({ error: "invalid_event_type" });
    process.exit(1);
  }

  const api = AffitorAPI.fromFlags(
    { apiKey: flags.apiKey, apiUrl: flags.apiUrl ?? config.api_url },
  );

  logger.newline();

  try {
    const result = await api.sendTestEvent({
      program_id: config.program_id,
      event_type: type,
    });

    if (flags.json) {
      logger.json(result);
      return;
    }

    if (result.received) {
      logger.success(`Test ${format.bold(type)} event received`);
      logger.step(`Event ID: ${result.event_id}`);

      if (result.attributed) {
        logger.success("Event attributed to test partner");
      } else {
        logger.step("Event received but not attributed (expected for test events)");
      }

      if (result.message) {
        logger.newline();
        logger.info(`  ${format.dim(result.message)}`);
      }
    } else {
      logger.error(`Test ${type} event was not received.`);
      logger.info(`  Check your connection: ${format.dim("$")} npx affitor status`);
    }
    logger.newline();
  } catch (err) {
    if (err instanceof APIError) {
      logger.error(`API error: ${err.message}`);
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
