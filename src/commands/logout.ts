import { Command } from "commander";
import { deleteCredentials, readCredentials } from "../lib/config.js";
import * as logger from "../lib/logger.js";

export function registerLogoutCommand(parent: Command) {
  parent
    .command("logout")
    .description("Log out and remove stored credentials")
    .action(async (_opts, cmd) => {
      const flags = cmd.optsWithGlobals();

      const existing = readCredentials();
      deleteCredentials();

      if (flags.json) {
        logger.json({ logged_out: true, email: existing?.email ?? null });
        return;
      }

      if (existing) {
        logger.success(`Logged out (was ${existing.email})`);
      } else {
        logger.info("  Not currently logged in.");
      }
    });
}
