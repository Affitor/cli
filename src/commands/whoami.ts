import { Command } from "commander";
import pc from "picocolors";
import { readCredentials } from "../lib/config.js";
import * as logger from "../lib/logger.js";

export function registerWhoamiCommand(parent: Command) {
  parent
    .command("whoami")
    .description("Show the currently logged-in user")
    .action(async (_opts, cmd) => {
      const flags = cmd.optsWithGlobals();
      const creds = readCredentials();

      if (!creds) {
        if (flags.json) {
          logger.json({ logged_in: false });
          return;
        }
        logger.info("");
        logger.info(`  Not logged in. Run ${pc.cyan("affitor login")} to authenticate.`);
        logger.info("");
        process.exit(1);
      }

      if (flags.json) {
        logger.json({
          logged_in: true,
          email: creds.email,
          advertiser_id: creds.advertiser_id || null,
          expires_at: creds.expires_at,
        });
        return;
      }

      const expiresIn = Math.ceil(
        (new Date(creds.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      );

      logger.titledBox("Account", [
        `Email          ${pc.cyan(creds.email)}`,
        `Advertiser     ${creds.advertiser_id || pc.dim("none")}`,
        `Token expires  ${expiresIn > 0 ? `in ${expiresIn} days` : pc.red("expired")}`,
      ]);
    });
}
