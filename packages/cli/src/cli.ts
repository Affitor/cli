#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import pc from "picocolors";
import { setLoggerOptions } from "./lib/logger.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerLogoutCommand } from "./commands/logout.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerInitCommand } from "./commands/init.js";
import { registerOnboardCommand } from "./commands/onboard.js";
import { registerSetupCommand } from "./commands/setup-stripe.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTestCommand } from "./commands/test.js";
import { registerProgramsCommand } from "./commands/programs.js";

// Read the version from package.json at runtime so `affitor --version` never
// drifts from the published package version (dist/cli.js → ../package.json).
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const program = new Command();

program
  .name("affitor")
  .description(
    "CLI-native affiliate tracking. Connect Stripe, track commissions, manage partners.",
  )
  .version(version)
  .option("--json", "Output as JSON (for agent parsing)", false)
  .option("--no-interactive", "Skip all prompts, fail on missing values")
  .option("--auto-confirm", "Auto-yes to all confirmation prompts", false)
  .option("--quiet", "Suppress non-essential output", false)
  .option("--api-key <key>", "Override API key from config")
  .option("--api-url <url>", "Override API URL (default: api.affitor.com)")
  .option("--verbose", "Debug-level output", false)
  .hook("preAction", () => {
    const opts = program.opts();
    setLoggerOptions({
      json: opts.json,
      quiet: opts.quiet,
      verbose: opts.verbose,
    });
  })
  .addHelpText("beforeAll", () => {
    const opts = program.opts();
    if (opts.json || opts.quiet) return "";

    const art = [
      `   ___    _______ __`,
      `  / _ |  / _/ _(_) /____  ____`,
      ` / __ | / _/ _/ / __/ _ \\/ __/`,
      `/_/ |_|/_//_//_/\\__/\\___/_/`,
    ];

    const lines = [
      "",
      ...art.map((l) => `  ${pc.cyan(l)}`),
      `  ${pc.dim("CLI-native affiliate tracking")}`,
      "",
    ];
    return lines.join("\n");
  });

registerLoginCommand(program);
registerLogoutCommand(program);
registerWhoamiCommand(program);
registerInitCommand(program);
registerOnboardCommand(program);
registerSetupCommand(program);
registerStatusCommand(program);
registerTestCommand(program);
registerProgramsCommand(program);

program.parse();
