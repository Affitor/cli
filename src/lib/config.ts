import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  CONFIG_DIR,
  CONFIG_FILE,
  SECRETS_FILE,
  GLOBAL_CONFIG_DIR,
  CREDENTIALS_FILE,
  type AffitorConfig,
  type AffitorSecrets,
  type UserCredentials,
} from "../types.js";
import * as logger from "./logger.js";

// ─── Project config (per-directory) ───────────────────────────────

function getConfigDir(cwd?: string): string {
  return join(cwd ?? process.cwd(), CONFIG_DIR);
}

function getConfigPath(cwd?: string): string {
  return join(getConfigDir(cwd), CONFIG_FILE);
}

function getSecretsPath(cwd?: string): string {
  return join(getConfigDir(cwd), SECRETS_FILE);
}

export function configExists(cwd?: string): boolean {
  return existsSync(getConfigPath(cwd));
}

export function readConfig(cwd?: string): AffitorConfig {
  const path = getConfigPath(cwd);
  if (!existsSync(path)) {
    throw new ConfigNotFoundError(resolve(cwd ?? process.cwd()));
  }
  const raw = readFileSync(path, "utf-8");
  const config = JSON.parse(raw) as AffitorConfig;

  // Auto-migrate v1 → v2
  if (config.version === 1 && config.api_key) {
    migrateV1ToV2(config, cwd);
  }

  return config;
}

export function writeConfig(config: AffitorConfig, cwd?: string): void {
  const dir = getConfigDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getConfigPath(cwd), JSON.stringify(config, null, 2) + "\n");
}

export function updateConfig(
  updates: Partial<AffitorConfig>,
  cwd?: string,
): AffitorConfig {
  const config = readConfig(cwd);
  const updated = { ...config, ...updates };
  writeConfig(updated, cwd);
  return updated;
}

// ─── Secrets (.affitor/.env) ──────────────────────────────────────

export function readSecrets(cwd?: string): AffitorSecrets | null {
  const path = getSecretsPath(cwd);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    vars[key] = value;
  }

  if (!vars.AFFITOR_API_KEY) return null;

  return {
    api_key: vars.AFFITOR_API_KEY,
    program_id: vars.AFFITOR_PROGRAM_ID ?? "",
    stripe_account_id: vars.STRIPE_CONNECTED_ACCOUNT_ID,
  };
}

export function writeSecrets(secrets: AffitorSecrets, cwd?: string): void {
  const dir = getConfigDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const lines = [
    "# Affitor secrets — auto-generated, DO NOT commit",
    `AFFITOR_API_KEY=${secrets.api_key}`,
    `AFFITOR_PROGRAM_ID=${secrets.program_id}`,
  ];
  if (secrets.stripe_account_id) {
    lines.push(`STRIPE_CONNECTED_ACCOUNT_ID=${secrets.stripe_account_id}`);
  }
  lines.push("");

  writeFileSync(getSecretsPath(cwd), lines.join("\n"));
}

// ─── Global credentials (~/.affitor/) ─────────────────────────────

function getGlobalDir(): string {
  return join(homedir(), GLOBAL_CONFIG_DIR);
}

function getCredentialsPath(): string {
  return join(getGlobalDir(), CREDENTIALS_FILE);
}

export function readCredentials(): UserCredentials | null {
  const path = getCredentialsPath();
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf-8");
  const creds = JSON.parse(raw) as UserCredentials;

  // Check expiry
  if (new Date(creds.expires_at) < new Date()) {
    return null;
  }

  return creds;
}

export function writeCredentials(creds: UserCredentials): void {
  const dir = getGlobalDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = getCredentialsPath();
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n");
  // Secure file permissions: owner read/write only
  chmodSync(path, 0o600);
}

export function deleteCredentials(): void {
  const path = getCredentialsPath();
  if (existsSync(path)) {
    writeFileSync(path, "");
    const { unlinkSync } = require("node:fs");
    unlinkSync(path);
  }
}

// ─── Resolve API key (priority chain) ─────────────────────────────

export function resolveApiKey(flags: { apiKey?: string }, cwd?: string): string | null {
  // 1. --api-key flag
  if (flags.apiKey) return flags.apiKey;

  // 2. AFFITOR_API_KEY env var
  if (process.env.AFFITOR_API_KEY) return process.env.AFFITOR_API_KEY;

  // 3. .affitor/.env (project secrets)
  const secrets = readSecrets(cwd);
  if (secrets?.api_key) return secrets.api_key;

  // 4. Legacy: config.json api_key (v1)
  try {
    const configPath = getConfigPath(cwd);
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw) as AffitorConfig;
      if (config.api_key) return config.api_key;
    }
  } catch {
    // ignore
  }

  return null;
}

// ─── v1 → v2 migration ───────────────────────────────────────────

function migrateV1ToV2(config: AffitorConfig, cwd?: string): void {
  logger.info("");
  logger.info(`  ${logger.format.yellow("Migrating")} config v1 → v2 (moving secrets to .env)...`);

  // Write secrets to .env
  if (config.api_key) {
    writeSecrets(
      {
        api_key: config.api_key,
        program_id: String(config.program_id),
        stripe_account_id: config.stripe_account_id,
      },
      cwd,
    );
  }

  // Strip secrets from config.json
  const cleaned: AffitorConfig = {
    version: 2,
    program_id: config.program_id,
    domain: config.domain,
    tracking_subdomain: config.tracking_subdomain,
    commission: config.commission,
    cookie: config.cookie,
    ref_param: config.ref_param,
    api_url: config.api_url,
    created_at: config.created_at,
  };

  writeConfig(cleaned, cwd);

  // Fix gitignore
  appendToGitignore(cwd);

  logger.success("Config migrated. Secrets now in .affitor/.env");
  logger.info("");
}

// ─── AGENTS.md / .env.example / gitignore ─────────────────────────

export function writeEnvExample(
  config: AffitorConfig,
  apiKey: string,
  cwd?: string,
): void {
  const dir = getConfigDir(cwd);
  const content = `# Affitor Tracking — auto-generated by \`npx affitor init\`
# Add these to your .env file

AFFITOR_API_KEY=${apiKey}
AFFITOR_PROGRAM_ID=${config.program_id}
# STRIPE_CONNECTED_ACCOUNT_ID=  (run \`npx affitor setup stripe\` to connect)
`;
  writeFileSync(join(dir, ".env.example"), content);
}

export function writeSkillsFile(
  config: AffitorConfig,
  programName: string,
  apiKey: string,
  cwd?: string,
): void {
  const dir = getConfigDir(cwd);
  const content = `# Affitor: ${programName}

> This file is auto-generated by \`npx affitor init\`.
> It is readable by Claude Code, Cursor, GitHub Copilot, Windsurf, Aider, and any AI coding tool that supports AGENTS.md.
> Docs: https://docs.affitor.com

## Project Context

This project uses Affitor for affiliate/partner tracking. Affitor tracks clicks, signups, and sales to attribute revenue to affiliate partners.

- **Program ID**: \`${config.program_id}\`
- **Domain**: \`${config.domain}\`
- **Commission**: ${formatCommission(config)}
- **Cookie Duration**: ${config.cookie.duration_days} days
- **API Base URL**: \`${config.api_url}\`
- **API Key**: stored in \`.affitor/.env\` as \`AFFITOR_API_KEY\`

## Integration Instructions

### 1. Click Tracking

Add this script tag to every page in \`<head>\`. It auto-detects affiliate visits via \`?aff=\` parameter and stores a first-party cookie.

\`\`\`html
<script src="${config.api_url}/js/affitor-tracker.js"
  data-affitor-program-id="${config.program_id}">
</script>
\`\`\`

For React/Next.js, use the SDK instead:

\`\`\`bash
npm install @affitor/tracker
\`\`\`

\`\`\`tsx
import { AffitorProvider } from '@affitor/tracker/react';

<AffitorProvider programId="${config.program_id}">
  {children}
</AffitorProvider>
\`\`\`

### 2. Signup/Lead Tracking

Call after user registration succeeds. The \`customerKey\` must be your internal user ID, reused in sale tracking.

\`\`\`javascript
// Browser-side (requires tracker script loaded)
await window.affitor.signup(user.id, user.email);
\`\`\`

\`\`\`bash
# Server-side alternative
curl -X POST ${config.api_url}/api/v1/track/lead \\
  -H "Authorization: Bearer $AFFITOR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"customer_key": "user_123", "email": "user@example.com"}'
\`\`\`

### 3. Sale/Revenue Tracking

**Option A: Stripe (recommended)** — run \`npx affitor setup stripe\` to auto-connect. Webhooks handle attribution automatically.

**Option B: Sale API (any payment provider)**

\`\`\`bash
curl -X POST ${config.api_url}/api/v1/track/sale \\
  -H "Authorization: Bearer $AFFITOR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "transaction_id": "txn_unique_id",
    "customer_key": "user_123",
    "amount_cents": 4900,
    "currency": "USD"
  }'
\`\`\`

Required fields: \`transaction_id\` (unique), \`amount_cents\` (positive integer), and at least one of \`customer_key\` or \`click_id\`.

**Option C: Stripe metadata (manual)** — add these fields to Stripe Checkout metadata:

\`\`\`javascript
metadata: {
  affitor_click_id: clickId,        // from cookie
  affitor_customer_key: user.id,    // your internal user ID
  program_id: '${config.program_id}'
}
\`\`\`

For subscriptions, duplicate the same metadata in \`subscription_data.metadata\`.

## Identifier Consistency

Use the same internal user ID everywhere:

| Context | Field Name |
|---|---|
| Browser signup helper | \`customerKey\` (1st argument) |
| Lead API | \`customer_key\` |
| Sale API | \`customer_key\` |
| Stripe metadata | \`affitor_customer_key\` |

## CLI Commands

\`\`\`bash
npx affitor status          # Check program health
npx affitor setup stripe    # Auto-connect Stripe via OAuth
npx affitor test click      # Send test click event
npx affitor test lead       # Send test lead event
npx affitor test sale       # Send test sale event
\`\`\`

## API Reference

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| \`/api/v1/track/lead\` | POST | Bearer API key | Track signup/lead |
| \`/api/v1/track/sale\` | POST | Bearer API key | Track sale/payment |
| \`/api/v1/cli/status\` | GET | Bearer API key | Program health check |

## Conventions

- All amounts are in cents (e.g., $49.00 = 4900)
- \`transaction_id\` must be unique per sale (duplicate returns 409)
- Test mode: add \`"additional_data": {"test_mode": true}\` to skip commission creation
- CLI flags for automation: \`--no-interactive --json\`
`;

  // Write as AGENTS.md (universal standard) + skills.md (backward compat)
  writeFileSync(join(dir, "AGENTS.md"), content);
  writeFileSync(join(dir, "skills.md"), content);
}

export function appendToGitignore(cwd?: string): void {
  const gitignorePath = join(cwd ?? process.cwd(), ".gitignore");
  const entries = [".affitor/.env", ".affitor/.env.*"];

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    const missing = entries.filter((e) => !content.includes(e));
    if (missing.length === 0) return;
    const block =
      "\n# Affitor secrets (do not commit)\n" +
      missing.map((e) => e + "\n").join("");
    writeFileSync(gitignorePath, content + block);
  } else {
    const block =
      "# Affitor secrets (do not commit)\n" +
      entries.map((e) => e + "\n").join("");
    writeFileSync(gitignorePath, block);
  }
}

function formatCommission(config: AffitorConfig): string {
  const { type, rate, duration_months } = config.commission;
  switch (type) {
    case "percent":
      return `${rate}% per sale`;
    case "fixed":
      return `$${rate} per sale`;
    case "recurring_percent":
      return `${rate}% recurring${duration_months ? ` for ${duration_months} months` : ""}`;
    case "recurring_fixed":
      return `$${rate} recurring${duration_months ? ` for ${duration_months} months` : ""}`;
  }
}

export class ConfigNotFoundError extends Error {
  constructor(dir: string) {
    super(
      `No Affitor config found in ${dir}.\n` +
        `Run ${"`npx affitor init`"} to set up your program.`,
    );
    this.name = "ConfigNotFoundError";
  }
}
