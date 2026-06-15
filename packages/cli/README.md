# affitor

CLI-native affiliate tracking. Connect Stripe, track commissions, manage partners -- all from your terminal.

## Quick Start

```bash
# Create your affiliate program
npx affitor init

# Connect Stripe for automatic payment tracking
npx affitor setup stripe

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
| `affitor setup stripe` | Connect Stripe via OAuth. Auto-configures webhooks for payment tracking. |
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
3. **Inject** — locates your Stripe webhook and adds the `affitor.trackSale` call (shown as a diff; non-Stripe stacks and unrecognized webhooks get the exact recipe printed instead — payment code is never auto-edited blindly).
4. **Verify** — fires the synthetic click → lead → sale chain, then **polls readiness until `integration_verified`** (or reports the blocking gate + next action).

It is **idempotent** — re-running skips work already done (existing env key, sale call already present) and never overwrites a different `AFFITOR_API_KEY`.

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

## Stripe Auto-Connect

`npx affitor setup stripe` automates the entire Stripe integration:

1. Opens Stripe Connect OAuth in your browser
2. Creates webhook endpoint on your Stripe account
3. Configures event listeners for:
   - `customer.created` -- lead tracking
   - `checkout.session.completed` -- sale tracking
   - `invoice.paid` -- recurring commissions
   - `invoice.payment_failed` -- failed payment alerts
   - `charge.refunded` -- automatic commission clawback
   - `customer.subscription.deleted` -- churn tracking

## Requirements

- Node.js >= 18
- Stripe account (for `setup stripe`)

## License

MIT
