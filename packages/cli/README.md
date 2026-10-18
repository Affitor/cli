# affitor

CLI-native affiliate tracking. Connect Stripe, track commissions, manage partners -- all from your terminal.

## AI agent setup

From the project root, preview the local installation before applying it:

```bash
affitor agent setup --client claude_code --dry-run --json
affitor agent setup --client claude_code --yes
affitor doctor --client claude_code --json
```

Choose `claude_code`, `cursor`, or `codex`; repeat `--client` for more than one.
Without a selection, an interactive terminal asks, with nothing selected by default.
Noninteractive runs require `--yes` and a selection. Inside an agent, setup can only
configure that agent. `--dry-run` writes nothing. Without confirmation, setup exits1.

Claude Code uses project `.mcp.json`; Cursor uses `.cursor/mcp.json`. Existing
unrelated settings are preserved. Existing file bytes are backed up under
`.affitor/backups/` before replacement, with mode0600; generated `.gitignore`
entries exclude backups and `.affitor/.env`. Updates use atomic replacement and
read-back, rolling back prior writes on failure. Backups and their local ignore
guard are kept on failure so a restored root `.gitignore` cannot expose them.
An existing backup guard must contain only `*`; negation or extra rules are refused.
Credential and backup ignore rules are appended at the end of both the root
`.gitignore` and `.affitor/.gitignore`, preserving earlier custom rules while
overriding negations. Existing files are backed up before changing them.
A concurrent edit is preserved;
inspect the files and private backups before retrying. This protects ordinary
local edits, not a hostile process racing filesystem operations.

The generated `.affitor/agent-mcp.cjs` launcher starts pinned `@affitor/mcp@0.2.2`
from this project's absolute directory. No credential is embedded in an agent
config, launcher, or skill. The launcher reads inherited `AFFITOR_API_KEY`, then
this project's `.affitor/.env` (created by `affitor init`). It never reads the user
login token in `~/.affitor/credentials.json`. If `onboard` wrote a key to your root
`.env`, provide it privately as `AFFITOR_API_KEY` when starting the agent instead.
It removes inherited API URL overrides regardless of their casing and uses the
production API. It disables sale/refund tools even when the parent
environment has `AFFITOR_MCP_WRITE=1`. Other tools still include tracking and
synthetic verification; approve those actions separately.

A recovery skill is installed in `.claude/skills/affitor/` or `.cursor/skills/affitor/`.
Codex gets `.agents/skills/affitor/` and a printed `codex mcp add` command; setup
does not edit its TOML config or run that command. Review it, then run it yourself.
If you move the project, run setup again to update absolute paths. The printed
command uses POSIX shell quoting on macOS/Linux. On Windows, no shell command
is generated: add the MCP in Codex settings using `command: "node"` and the exact
absolute path from the preview's `entry.args` as one argument. Do not paste POSIX
commands into cmd.exe.

**Installed is not verified.** Successful setup returns `needs_human` (exit0).
`doctor` is read-only and static: it does not start an agent, connect to the API,
or prove the key works. It returns `aligned`/`stale`/`missing`/`manual`/`invalid`
per client and `present_unverified`/`missing` for credentials. With no selection,
doctor checks existing JSON client configs; an agent caller checks itself.
Exit0 means all selected static checks align and a credential is present;
otherwise exit1. Restart the agent and ask it to call `affitor_readiness`, checking
the program identity before integration. Only report the readiness checks that pass.

Doctor and the launcher use the same credential parser: empty, duplicate and
interpolated assignments fail closed. An explicit nonempty environment value
takes precedence and is validated without reading a file. On Windows, the
launcher runs `npx.cmd` through `cmd.exe` with a constant command; project paths
and credentials are passed through `cwd`/environment, outside shell text.

This local installer uses an existing program key. Per-agent key issuance,
pairing, connection telemetry, and the dashboard Agents page are separate work;
this command does not claim to create or verify an agent connection.

## Quick Start

```bash
# Create your affiliate program
npx affitor init

# Connect Stripe in the Affitor dashboard: Program settings → Payments, Connect Stripe

# Check program health
npx affitor status

# Send test events
npx affitor test click
npx affitor test lead
npx affitor test sale
```

## Commands

| Command | Description |
|---|---|
| `affitor init` | Create a new affiliate program. Interactive prompts or `--no-interactive` with flags. |
| `affitor onboard` | Wire Affitor into an existing app end-to-end: detect → install browser tracking → inject the Stripe sale call → verify. |
| `affitor setup stripe` | Points you to the dashboard, where Stripe is connected (Program settings → Payments, Connect Stripe). Exits 1. |
| `affitor setup dns` | Set up DNS CNAME tracking (coming soon). |
| `affitor status` | Show program health: DNS, Stripe connection, recent events. |
| `affitor test [type]` | Send a test event (`click`, `lead`, or `sale`). |

## `affitor onboard`

One command to wire Affitor into an existing app and prove it works. Where `init`
creates the program, `onboard` integrates it into your codebase:

```bash
npx affitor onboard
```

It runs the **detect → wire → inject → verify** flow:

1. **Detect** — your framework (`next-app`, `next-pages`, `fastify`, `express`, `node`) and payment provider (Stripe, …).
2. **Wire** — installs `@affitor/sdk`, injects `<AffitorTracker/>` browser tracking, scaffolds the server client, and persists `AFFITOR_API_KEY` into `.env.local`/`.env`.
3. **Review sale tracking** — if the program has a Stripe account bound in Affitor, the webhook stays unchanged to avoid a second sale path. When the runtime key or Connect state is uncertain, the CLI asks whether to keep the existing webhook unchanged (default Yes). Only choose No after confirming the runtime program key and ruling out current/shared-account/delayed Connect sales; a separate diff approval is required before adding `affitor.trackSale`. Unknown status never recommends removing an existing sale call. `--yes`, `--no-interactive` and `--json` leave Stripe webhooks unchanged when Connect cannot be ruled out. A conflicting runtime API key always requires manual review. Non-Stripe stacks and unrecognized webhooks get a recipe to review and add manually.
4. **Verify** — fires the synthetic click → lead → sale chain, then **polls readiness until `integration_verified`** (or reports the blocking gate + next action).

It is **idempotent** — re-running skips work already done (existing env key, sale call already present) and never overwrites a different `AFFITOR_API_KEY`. The CLI trusts status only when the inherited process key and standard env layers declare one distinct usable key matching the checked key. It parses dotenv syntax (including colon assignments and quoted multiline values) without evaluating or expanding it. Duplicate assignments, conflicting keys across `.env`, `.env.local`, and `.env.{production,development,test}[.local]`, unreadable/nonregular files, or any other root `.env*` file make the runtime key uncertain. This includes custom modes and templates: the CLI does not infer how they are loaded. In interactive mode it asks and defaults to keeping the existing snippet; unattended runs keep it unchanged. Ambiguous env files are never overwritten. If no runtime key exists and every standard layer is readable, the normal env initialization can still add the explicit program key.

| Flag | Description |
|---|---|
| `--api-key <key>` | Program API key (overrides env / `.affitor/.env`). |
| `--yes` | Auto-confirm all diffs (apply without prompting). |
| `--json` | Machine-readable summary (steps + `integration_verified`) for agents. In `--json`/`--no-interactive` mode files are never auto-edited; recipes are returned for the agent to apply. |

## Global Flags

| Flag | Description |
|---|---|
| `--json` | Output as JSON (for AI agents and scripts) |
| `--no-interactive` | Skip all prompts, fail on missing values |
| `--auto-confirm` | Auto-yes to confirmation prompts |
| `--quiet` | Suppress non-essential output |
| `--api-key <key>` | Override API key from config |
| `--api-url <url>` | Override API URL |
| `--verbose` | Debug output |

## Non-Interactive Mode (for AI Agents)

```bash
npx affitor init \
  --name "My SaaS" \
  --domain "example.com" \
  --commission-type recurring_percent \
  --commission-rate 20 \
  --duration-months 12 \
  --cookie-duration 90 \
  --no-interactive \
  --json
```

## What Gets Created

Running `npx affitor init` creates:

```
.affitor/
  config.json     -- program configuration
  .env.example    -- environment variables template
  skills.md       -- AI agent instructions
```

## Stripe

Stripe is connected from the Affitor dashboard (Program settings → Payments, Connect Stripe), not from the CLI. Affitor's own webhook then records sales and renewals; add Affitor metadata to your checkout so sales are attributed reliably.

## Requirements

- Node.js >= 18

## License

MIT
