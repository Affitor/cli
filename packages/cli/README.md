# affitor

CLI-native affiliate tracking. Connect Stripe, track commissions, manage partners -- all from your terminal.

## AI agent setup

Preview the selected client's installation from your project root. Sign in using
Affitor's existing login command, then apply the plan:

```bash
affitor login
affitor agent setup --client claude_code --program-id 123 --dry-run --json
affitor agent setup --client claude_code --program-id 123 --yes
affitor doctor --client claude_code --json
```

`--program-id` is optional when `.affitor/config.json` already links a program.
An interactive terminal can select a program from the signed-in account's list.
Without a linked/selected program, setup remains a local installer using an existing
program key and explains how to rerun for separate agent credentials. It does not
mint a key in this mode. Existing per-client setups cannot be downgraded to this
legacy mode: pass the program id when updating them. This feature requires the CMS program-agent API release;
a missing route or insufficient Owner access fails without falling back to a live key.

Choose `claude_code`, `cursor`, or `codex`; repeat `--client` for more than one.
Detected clients are not selected automatically. Inside an agent, setup can only
configure itself. Noninteractive runs require a selection and `--yes` (or
`--auto-confirm`). `--dry-run` makes no API calls and writes nothing. Without consent,
setup exits1. A linked project with no valid saved login returns `needs_login`
(exit1), with no minted key or local write. Run `affitor login` and retry.

For a selected program, each client gets its own restricted `aff_ag_` credential.
Only an active program Owner can mint/list/revoke it through the user-JWT lifecycle
API. Neither `--api-key` nor inherited `AFFITOR_API_KEY` is used as that user JWT.
Setup lists existing credentials to reuse a matching active local key, without
calling readiness/status or marking an agent connected. Revoked or missing rows
are replaced on the next approved setup. The keys permit readiness, status,
synthetic checks, click and lead; they cannot authorize sale/refund.

Private credentials live at `.affitor/agents/<client>.json` (mode0600 on POSIX),
separate from the application's live key in `.affitor/.env`. Setup preserves the
application key. The JSON includes the key's id, program, client, API origin and
an unverified scope/date note. Do not commit or share this file. A selected
credential belonging to another program/origin must be revoked and removed before
switching. Unsafe paths, malformed private files, POSIX permissions broader than
owner-only and Git-tracked private credentials are refused.

Claude Code uses project `.mcp.json`; Cursor uses `.cursor/mcp.json`. Their entries
contain only `node`, an absolute `.affitor/agent-mcp.cjs` path and a client selector.
No credential appears in MCP config, the launcher, skill, plan or command output.
The launcher reads only the selected client's private file, ignoring inherited or
application keys. A missing/invalid selected key fails closed. Its API origin comes
from that private record (default production; use an explicit `--api-url` for an
HTTPS custom origin). It never reads a user login token. Legacy entries with no
client selector still read inherited `AFFITOR_API_KEY`, then `.affitor/.env`, using
the same strict env parser as static doctor. Their API origin remains production.

Existing unrelated settings are preserved. Changed file bytes are backed up under
`.affitor/backups/` before replacement, with mode0600. Credential, login-token and
backup ignores are appended to root and child `.gitignore` files; strict `*`
guards protect private agent files and backups before the first secret write.
Temporary writes stay under the ignored backup directory, including after abrupt
termination. Updates use atomic replacement and read-back, rolling back prior writes
on failure. Concurrent edits are preserved, with private ignore guards retained.
Inspect files and private backups before retrying. This handles ordinary local
edits; it is not a sandbox against hostile local filesystem races.

Mint requests are never retried automatically. If a later mint or local write
fails, setup attempts to revoke every newly minted key whose id it received.
`revoke_failed_ids` lists known ids needing dashboard cleanup;
`mint_outcome_unknown: true` means a lost/failed response may have created another
Waiting row. Review unused Waiting credentials in Settings → Agents and revoke them
before retrying. An unknown mint result is not reported as a successful rollback.
Reuse does not revoke pre-existing keys when a local update fails.

A recovery skill is installed in `.claude/skills/affitor/` or `.cursor/skills/affitor/`.
Codex gets `.agents/skills/affitor/` and a printed command; setup does not edit its
TOML or run the command. On Windows, add the MCP in Codex settings using the exact
command/argument array in `entries.codex` from the preview. No shell command is
printed. On macOS/Linux the printed command uses POSIX quoting. Paths are specific
to this machine: keep generated configs local or regenerate after moving the
project or on a teammate's machine.

**Installed is not verified.** Credential setup returns `needs_next_step` (exit0);
local-only installation returns `needs_human` (exit0). Setup does not run an agent,
call readiness, or infer Verified from installation. Restart the client and ask:
“Call affitor_readiness from Affitor and tell me the result.” Check the program
identity and report only checks that actually pass. Approve synthetic checks and
other writes separately.

`doctor` is read-only and static: it does not start an agent or connect to the API.
It returns `aligned`/`stale`/`missing`/`manual`/`invalid` per client and
`present_unverified`/`missing` for credentials. With no selection it checks existing
JSON client configs; an agent caller checks itself. Exit0 means selected static
checks align, credentials are present and no warning exists. Codex stays manual.
A `credential_tracked` warning returns exit1; Git checks include parent repository
roots and do not change the index. Rotate exposed keys and resolve tracking/history
through your repository process; an ignore rule does not untrack them.

The launcher starts pinned `@affitor/mcp@0.2.2` with sale/refund tools disabled even
when the parent sets `AFFITOR_MCP_WRITE=1`. Windows uses a constant `cmd.exe` command
with `NoDefaultCurrentDirectoryInExePath=1`; paths/keys stay outside shell text.
The child receives only runtime paths, home/temp, locale/terminal settings, its
credential and explicit origin. Parent proxy, Node options, npm overrides and
unrelated credentials are dropped; npm uses the public registry. Project code,
PATH, `.npmrc` and the launcher remain part of your trusted local environment.

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
