import { Command } from "commander";
import pc from "picocolors";
import { exec } from "node:child_process";
import { AffitorAPI } from "../lib/api-client.js";
import { writeCredentials, readCredentials } from "../lib/config.js";
import * as logger from "../lib/logger.js";
import type { UserCredentials } from "../types.js";
import { DEFAULT_API_URL } from "../types.js";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function registerLoginCommand(parent: Command) {
  parent
    .command("login")
    .description("Log in to Affitor via your browser")
    .action(async (_opts, cmd) => {
      const flags = cmd.optsWithGlobals();
      await runLogin(flags);
    });
}

async function runLogin(flags: { apiUrl?: string; json?: boolean }) {
  // Check if already logged in
  const existing = readCredentials();
  if (existing) {
    if (flags.json) {
      logger.json({ already_logged_in: true, email: existing.email });
      return;
    }
    logger.info("");
    logger.info(`  Already logged in as ${pc.cyan(existing.email)}`);
    logger.info(`  Run ${pc.dim("affitor logout")} to switch accounts.`);
    logger.info("");
    return;
  }

  const api = new AffitorAPI({ apiUrl: flags.apiUrl ?? DEFAULT_API_URL });

  // Step 1: Start auth session
  logger.info("");
  logger.step("Starting login...");

  const { state, auth_url, expires_at } = await api.authStart();

  // Step 2: Open browser
  logger.info("");
  logger.info(`  ${pc.bold("Open this URL to log in:")}`);
  logger.info("");
  logger.info(`  ${pc.cyan(auth_url)}`);
  logger.info("");

  openBrowser(auth_url);
  logger.step("Waiting for browser login...");

  // Step 3: Poll until complete or expired
  const deadline = new Date(expires_at).getTime();
  const startTime = Date.now();
  let dots = 0;

  while (Date.now() < deadline && Date.now() - startTime < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const result = await api.authPoll(state);

    if (result.status === "complete" && result.token) {
      const creds: UserCredentials = {
        token: result.token,
        email: result.email ?? "",
        user_id: "",
        advertiser_id: String(result.advertiser_id ?? ""),
        expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      };

      writeCredentials(creds);

      if (flags.json) {
        logger.json({
          logged_in: true,
          email: creds.email,
          advertiser_id: creds.advertiser_id,
          next_steps: [
            "affitor init",
            "affitor programs",
            "affitor status",
          ],
        });
        return;
      }

      logger.info("");
      logger.success(`Logged in as ${pc.cyan(creds.email)}`);
      logger.info("");
      logger.info(`  Credentials saved to ${pc.dim("~/.affitor/credentials.json")}`);
      logger.info(`  Token expires in 90 days.`);

      logger.titledBox("What's next?", [
        "",
        `  ${pc.cyan("affitor init")}        ${pc.dim("Set up a new affiliate program")}`,
        `  ${pc.cyan("affitor programs")}    ${pc.dim("List your programs")}`,
        `  ${pc.cyan("affitor status")}      ${pc.dim("Check program health")}`,
        `  ${pc.cyan("affitor help")}        ${pc.dim("See all commands")}`,
        "",
      ]);
      return;
    }

    if (result.status === "expired") {
      logger.error("Login session expired. Run `affitor login` to try again.");
      process.exit(1);
    }

    if (result.status === "consumed") {
      logger.error("Login session already used. Run `affitor login` to try again.");
      process.exit(1);
    }

    // Show waiting indicator
    dots = (dots + 1) % 4;
    if (!flags.json) {
      process.stdout.write(`\r  ${pc.dim("Waiting" + ".".repeat(dots) + " ".repeat(3 - dots))}  `);
    }
  }

  logger.info("");
  logger.error("Login timed out. Run `affitor login` to try again.");
  process.exit(1);
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) {
      logger.debug(`Failed to open browser: ${err.message}`);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
