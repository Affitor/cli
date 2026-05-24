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
| `affitor setup stripe` | Connect Stripe via OAuth. Auto-configures webhooks for payment tracking. |
| `affitor setup dns` | Set up DNS CNAME tracking (coming soon). |
| `affitor status` | Show program health: DNS, Stripe connection, recent events. |
| `affitor test [type]` | Send a test event (`click`, `lead`, or `sale`). |

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
