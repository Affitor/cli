import { Command } from "commander";
import pc from "picocolors";
import { AffitorAPI } from "../lib/api-client.js";
import { readCredentials } from "../lib/config.js";
import * as logger from "../lib/logger.js";
import { DEFAULT_API_URL } from "../types.js";

export function registerProgramsCommand(parent: Command) {
  parent
    .command("programs")
    .description("List your affiliate programs")
    .action(async (_opts, cmd) => {
      const flags = cmd.optsWithGlobals();
      await runPrograms(flags);
    });
}

async function runPrograms(flags: { apiUrl?: string; json?: boolean }) {
  const creds = readCredentials();
  if (!creds) {
    logger.error("You must be logged in to list programs.");
    logger.info("");
    logger.info(`  Run ${pc.cyan("affitor login")} first.`);
    logger.info("");
    if (flags.json) {
      logger.json({ error: "not_logged_in" });
    }
    process.exit(1);
  }

  const api = new AffitorAPI({
    apiUrl: flags.apiUrl ?? DEFAULT_API_URL,
    apiKey: creds.token,
  });

  const programs = await api.listPrograms();

  if (flags.json) {
    logger.json({ programs });
    return;
  }

  if (programs.length === 0) {
    logger.info("");
    logger.info("  No programs found.");
    logger.info("");
    logger.info(`  Run ${pc.cyan("affitor init")} to create your first program.`);
    logger.info("");
    return;
  }

  logger.info("");
  logger.info(`  ${pc.bold("Your Programs")} ${pc.dim(`(${programs.length})`)}`);
  logger.info("");

  for (const prog of programs) {
    const statusColor = prog.status === "active" ? pc.green : pc.yellow;
    logger.info(
      `  ${pc.cyan(String(prog.id).padEnd(6))} ${pc.bold(prog.name.padEnd(24))} ${statusColor(prog.status.padEnd(10))} ${pc.dim(prog.domain)}`,
    );
    logger.info(
      `  ${" ".repeat(6)} ${pc.dim(prog.commission.padEnd(24))} ${pc.dim(`${prog.partners} partners`)}`,
    );
    logger.info("");
  }
}
