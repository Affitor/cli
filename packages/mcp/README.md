# @affitor/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) **stdio server** for [Affitor](https://affitor.com).

It exposes Affitor's affiliate-tracking capabilities as MCP tools so AI agents — Claude Desktop, Cursor, and any other MCP client — can report clicks, leads, sales and refunds, and poll integration readiness, directly as tool calls.

Under the hood it wraps the consolidated server client [`@affitor/sdk/server`](https://www.npmjs.com/package/@affitor/sdk) (the `Affitor` class). Authentication is your **program API key**, supplied via the `AFFITOR_API_KEY` environment variable.

## Add it to your MCP client

Add this to your client's MCP server config (e.g. `claude_desktop_config.json` for Claude Desktop, or `.cursor/mcp.json` for Cursor):

```json
{
  "mcpServers": {
    "affitor": {
      "command": "npx",
      "args": ["-y", "@affitor/mcp"],
      "env": {
        "AFFITOR_API_KEY": "your_program_key"
      }
    }
  }
}
```

Restart your client and the `affitor` tools will be available to the agent.

## Environment variables

| Variable           | Required | Description                                                                 |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `AFFITOR_API_KEY`  | Yes      | Your Affitor **program API key** (Bearer). Server-side only — never ship it to a browser. |
| `AFFITOR_API_URL`  | No       | API base override. Defaults to `https://api.affitor.com`.                    |

If `AFFITOR_API_KEY` is not set, the server prints a clear message to stderr and exits.

## Tools

| Tool                   | Description                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `affitor_readiness`    | Check this program's integration/onboarding readiness — returns a 5-gate verdict + blocker + next_action. Poll until `integration_verified` is true. |
| `affitor_track_lead`   | Report a lead/signup. Binds the customer to the click so later sales attribute by `customerExternalId` alone.                            |
| `affitor_track_sale`   | Report a sale. Resolves attribution by `customerExternalId` (bound at lead time).                                                        |
| `affitor_track_refund` | Report a refund (omit amount = full → commission reversed; partial → refunded). Idempotent by `invoiceId`.                               |
| `affitor_track_click`  | Report a click (usually browser-side; public, no customer needed).                                                                       |

### Inputs

**`affitor_readiness`**
- `forceRecheck?: boolean` — force a fresh server-side recheck instead of the cached verdict.

**`affitor_track_lead`** (one of `customerExternalId` / `clickId` is required)
- `customerExternalId?: string` — your own user id; binds this customer to the click.
- `clickId?: string` — Affitor click id (from the `affitor_click_id` cookie).
- `email?: string`

**`affitor_track_sale`** (one of `customerExternalId` / `clickId` is required)
- `customerExternalId?: string` — your own user id; resolves attribution (no `clickId` needed once bound at lead time).
- `clickId?: string`
- `amount: number` — sale amount in **integer cents** (e.g. `4999` = $49.99).
- `invoiceId: string` — idempotency key (your invoice / transaction id).
- `currency?: string` — ISO currency code (default `USD`).
- `saleType?: "payment" | "subscription"`
- `isRecurring?: boolean`
- `subscriptionId?: string`
- `subscriptionInterval?: "monthly" | "quarterly" | "annual"`

**`affitor_track_refund`**
- `invoiceId: string` — the sale's idempotency key (the `invoiceId` you passed to `affitor_track_sale`).
- `refundAmountCents?: number` — integer cents. Omit (or `0`) = full refund → commission reversed; partial → refunded.
- `refundReason?: string`

**`affitor_track_click`** (all optional)
- `affiliateUrl?: string`
- `pageUrl?: string`
- `referrerUrl?: string`
- `existingClickId?: string`

Each tool returns the Affitor API's JSON payload as text content. On a failed request (a thrown error or an `{ ok: false }` envelope) the tool returns an MCP error result with the message.

## License

MIT
