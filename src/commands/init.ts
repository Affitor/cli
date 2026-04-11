import type { Command } from "commander";
import * as logger from "../lib/logger.js";
import { format } from "../lib/logger.js";
import { AffitorAPI, APIError, NetworkError } from "../lib/api-client.js";
import {
  configExists,
  writeConfig,
  writeSecrets,
  writeEnvExample,
  writeSkillsFile,
  appendToGitignore,
} from "../lib/config.js";
import {
  promptProgramName,
  promptDomain,
  promptCommissionType,
  promptCommissionRate,
  promptDurationMonths,
  promptCookieDuration,
  confirmAction,
} from "../lib/prompts.js";
import type { AffitorConfig, CLIFlags, CommissionType } from "../types.js";
import { DEFAULT_API_URL } from "../types.js";
import { getFlags } from "../lib/flags.js";

export function registerInitCommand(program: Command) {
  program
    .command("init")
    .description("Initialize a new Affitor affiliate program")
    .option("--name <name>", "Program name")
    .option("--domain <domain>", "Root domain (e.g., example.com)")
    .option(
      "--commission-type <type>",
      "Commission type: percent, fixed, recurring_percent, recurring_fixed",
    )
    .option("--commission-rate <rate>", "Commission rate (% or $)", parseFloat)
    .option("--cookie-duration <days>", "Cookie duration in days", parseInt)
    .option("--duration-months <months>", "Commission duration in months (for recurring)", parseInt)
    .action(async (opts, cmd) => {
      await runInit(opts, getFlags(cmd));
    });
}

async function runInit(
  opts: {
    name?: string;
    domain?: string;
    commissionType?: string;
    commissionRate?: number;
    cookieDuration?: number;
    durationMonths?: number;
  },
  flags: CLIFlags,
) {
  if (configExists()) {
    logger.error(
      "Affitor already configured in this directory.\n" +
        "  Use `npx affitor status` to check your program.\n" +
        "  Delete `.affitor/` to reinitialize.",
    );
    if (flags.json) {
      logger.json({ error: "already_configured" });
    }
    process.exit(1);
  }

  const interactive = !flags.noInteractive;

  let name = opts.name;
  let domain = opts.domain;
  let commissionType = opts.commissionType as CommissionType | undefined;
  let commissionRate = opts.commissionRate;
  let cookieDuration = opts.cookieDuration;
  let durationMonths = opts.durationMonths;

  if (interactive) {
    logger.banner();
    logger.titledBox("Setup", [
      "",
      "  Configure your affiliate program in under a minute.",
      "  You'll need: program name, domain, and commission structure.",
      "",
    ]);

    name ??= await promptProgramName();
    domain ??= await promptDomain();
    commissionType ??= await promptCommissionType();
    commissionRate ??= await promptCommissionRate(commissionType);

    if (commissionType.startsWith("recurring")) {
      durationMonths ??= await promptDurationMonths();
    }

    cookieDuration ??= await promptCookieDuration();
  }

  if (!name || !domain || !commissionType || commissionRate === undefined) {
    logger.error(
      "Missing required options. In non-interactive mode, provide:\n" +
        "  --name <name> --domain <domain> --commission-type <type> --commission-rate <rate>",
    );
    if (flags.json) {
      logger.json({ error: "missing_options" });
    }
    process.exit(1);
  }

  // Clean domain
  domain = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  cookieDuration ??= 90;

  if (interactive && !flags.autoConfirm) {
    logger.newline();
    logger.titledBox("Review", [
      "",
      `  Program:    ${format.bold(name)}`,
      `  Domain:     ${format.cyan(domain)}`,
      `  Commission: ${format.green(formatCommission(commissionType, commissionRate, durationMonths))}`,
      `  Cookie:     ${cookieDuration} days`,
      "",
    ]);

    const confirmed = await confirmAction("Create this program?");
    if (!confirmed) {
      logger.info("Cancelled.");
      process.exit(0);
    }
  }

  const apiUrl = flags.apiUrl ?? DEFAULT_API_URL;
  const api = new AffitorAPI({ apiUrl });

  const totalSteps = 4;

  logger.newline();

  let response;
  try {
    response = await api.initProgram({
      name,
      domain,
      commission_type: commissionType,
      commission_rate: commissionRate,
      cookie_duration: cookieDuration,
      duration_months: durationMonths,
    });
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

  logger.progressStep(1, totalSteps, "Program registered", true);

  // Config v2: secrets go to .env, config.json has no secrets
  const config: AffitorConfig = {
    version: 2,
    program_id: response.program_id,
    domain,
    tracking_subdomain: `t.${domain}`,
    commission: {
      type: commissionType,
      rate: commissionRate,
      duration_months: durationMonths,
    },
    cookie: {
      name: "_aff",
      duration_days: cookieDuration,
    },
    ref_param: "aff",
    api_url: apiUrl,
    created_at: new Date().toISOString(),
  };

  writeConfig(config);
  logger.progressStep(2, totalSteps, "Config written to .affitor/config.json", true);

  // Write secrets to .env (gitignored)
  writeSecrets({
    api_key: response.api_key,
    program_id: response.program_id,
  });

  writeEnvExample(config, response.api_key);
  writeSkillsFile(config, name, response.api_key);
  logger.progressStep(3, totalSteps, "Secrets → .affitor/.env + AGENTS.md", true);

  appendToGitignore();
  logger.progressStep(4, totalSteps, "Gitignore updated", true);

  if (flags.json) {
    logger.json({
      program_id: response.program_id,
      api_key: response.api_key,
      domain,
      status: "created",
      tracking: {
        script_tag: `<script src="${apiUrl}/js/affitor-tracker.js" data-affitor-program-id="${response.program_id}"></script>`,
        signup_call: `window.affitor.signup("customer_id", "email@example.com")`,
        sale_api: `POST ${apiUrl}/api/v1/track/sale`,
        lead_api: `POST ${apiUrl}/api/v1/track/lead`,
      },
      next_steps: [
        "Add script tag to your site <head>",
        "Call window.affitor.signup() on user registration",
        "Run: npx affitor setup stripe",
        "Run: npx affitor test click",
      ],
    });
    return;
  }

  logger.titledBox("Program Created", [
    "",
    `  Program ID:  ${format.bold(response.program_id)}`,
    `  API Key:     ${format.dim(".affitor/.env (gitignored)")}`,
    `  Domain:      ${format.cyan(domain)}`,
    `  Commission:  ${format.green(formatCommission(commissionType, commissionRate, durationMonths))}`,
    "",
  ]);

  logger.titledBox("Next Steps", [
    "",
    `  ${format.bold(format.cyan("1"))}  Add tracking script to your ${format.dim("<head>")}:`,
    "",
    `     ${format.cyan(`<script src="${apiUrl}/js/affitor-tracker.js"`)}`,
    `     ${format.cyan(`  data-affitor-program-id="${response.program_id}">`)}`,
    `     ${format.cyan(`</script>`)}`,
    "",
    `  ${format.bold(format.cyan("2"))}  Track signups ${format.dim("(call after user registers)")}:`,
    "",
    `     ${format.cyan(`window.affitor.signup("user_id", "email@example.com");`)}`,
    "",
    `  ${format.bold(format.cyan("3"))}  Connect Stripe:`,
    `     ${format.dim("$")} npx affitor setup stripe`,
    "",
    `  ${format.bold(format.cyan("4"))}  Test integration:`,
    `     ${format.dim("$")} npx affitor test click`,
    "",
  ]);

  logger.info(`  ${format.dim("Files:")} .affitor/config.json  ·  .env  ·  AGENTS.md  ·  .env.example`);
  logger.info(`  ${format.dim("Docs:")} https://docs.affitor.com/advertisers/tracking`);
  logger.newline();
}

function formatCommission(
  type: CommissionType,
  rate: number,
  durationMonths?: number,
): string {
  const isPercent = type.includes("percent");
  const value = isPercent ? `${rate}%` : `$${rate}`;
  const isRecurring = type.startsWith("recurring");
  if (isRecurring) {
    const duration = durationMonths === 0 ? "lifetime" : `${durationMonths} months`;
    return `${value} recurring (${duration})`;
  }
  return `${value} per sale`;
}
