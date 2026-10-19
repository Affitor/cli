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
| `AFFITOR_API_KEY`  | For tracking tools | Your Affitor **program API key** (Bearer). Server-side only — never ship it to a browser. |
| `AFFITOR_API_URL`  | No       | API base override. Defaults to `https://api.affitor.com`.                    |
| `AFFITOR_MCP_WRITE` | No      | Set to `1` to register the two tools that move money: `affitor_track_sale` and `affitor_track_refund`. Off by default, so an agent exploring tools cannot create a real sale or reverse a commission. |
| `AFFITOR_AGENT_KEY` | For coupon tools | An Affitor **agent key** with the `coupons:write` scope. Used only by the coupon tools, never by the tracking tools. Server-side only. |
| `AFFITOR_MCP_COUPONS` | No    | Set to `1` to add the coupon tools. Needs `AFFITOR_AGENT_KEY`. Off by default. |

The two tool families are independent: the tracking tools need `AFFITOR_API_KEY`, the coupon tools need `AFFITOR_AGENT_KEY` plus `AFFITOR_MCP_COUPONS=1`, and neither key is ever used in place of the other. If neither family is configured, the server prints a clear message to stderr and exits.

## Tools

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), so a client can ask before a write. `affitor_track_sale` and `affitor_track_refund` are marked destructive and only exist with `AFFITOR_MCP_WRITE=1`.

| Tool                            | Description                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `affitor_readiness`             | Check this program's integration/onboarding readiness — returns a 5-gate verdict + blocker + next_action. Poll until `integration_verified` is true. |
| `affitor_track_lead`            | Report a lead/signup. Binds the customer to the click so later sales attribute by `customerExternalId` alone.                            |
| `affitor_track_sale`            | Needs `AFFITOR_MCP_WRITE=1`. Report a sale: creates a real sale and commission unless `testMode` is true. Resolves attribution by `customerExternalId` (bound at lead time). |
| `affitor_track_refund`          | Needs `AFFITOR_MCP_WRITE=1`. Report a refund (omit amount = full → commission reversed; partial → refunded). Idempotent by `invoiceId`. `testMode` is a dry run. |
| `affitor_track_click`           | Report a click (usually browser-side; public, no customer needed).                                                                       |
| `affitor_get_integration_plan`  | Return the deterministic payment-tracking integration plan for a stack — install, checkout-metadata snippet, `trackSale` snippet + where to inject it, and the verify step. **Pure** — reads the canonical [`@affitor/recipes`](https://www.npmjs.com/package/@affitor/recipes) registry; no SDK client, no network, no side-effects. The agent follows this instead of guessing a contract. |
| `affitor_run_verification`      | Fire the synthetic click → lead → sale verification chain through Affitor's REAL attribution pipeline (isolated `is_test` rows). The agent's proof step: run it, then poll `affitor_readiness` until `integration_verified` is true. Rate-limited to **10/program/hour** — on a `rate_limited` result, wait `retry_after_seconds`, don't hammer. |

### Inputs

**`affitor_readiness`**
- `forceRecheck?: boolean` — force a fresh server-side recheck instead of the cached verdict.

**`affitor_track_lead`** (one of `customerExternalId` / `clickId` is required)
- `customerExternalId?: string` — your own user id; binds this customer to the click.
- `clickId?: string` — Affitor click id (from the `affitor_click_id` cookie).
- `email?: string`
- `testMode?: boolean` — record a test lead (`is_test`).

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
- `testMode?: boolean` — record a test sale (`is_test`, no commission), sent as transaction `test_<invoiceId>` so it never blocks the real sale with the same invoice.

**`affitor_track_refund`**
- `invoiceId: string` — the sale's idempotency key (the `invoiceId` you passed to `affitor_track_sale`).
- `refundAmountCents?: number` — integer cents. Omit (or `0`) = full refund → commission reversed; partial → refunded.
- `refundReason?: string`
- `testMode?: boolean` — dry run: returns the refund that would be sent and calls nothing (the API has no test refunds).

**`affitor_track_click`** (all optional)
- `affiliateUrl?: string`
- `pageUrl?: string`
- `referrerUrl?: string`
- `existingClickId?: string`

**`affitor_get_integration_plan`**
- `framework: "next-app" | "next-pages" | "fastify" | "express" | "node" | "unknown"` — the detected app framework; determines where `trackSale` is injected.
- `provider?: "stripe" | "polar" | "lemonsqueezy" | "paddle" | "unknown"` — the detected payment provider (default `stripe`).
- `mode?: "stripe_connect" | "s2s"` — payment-tracking mode (default `stripe_connect`). `stripe_connect` = Connect autocaptures the sale (metadata only, no `trackSale`); `s2s` = inject `trackSale` in your webhook. Returns `{ steps, recipe }`.

**`affitor_run_verification`** (no input)
- Fires the synthetic verification chain and returns the parsed result. On a rate limit it returns `{ http_status: 429, retry_after_seconds, … }` rather than throwing — back off and retry.

Each tool returns the Affitor API's JSON payload as text content. On a failed request (a thrown error or an `{ ok: false }` envelope) the tool returns an MCP error result with the message.

## Coupon tools

`affitor_create_coupon`, `affitor_lock_coupon` and `affitor_get_coupon` let an agent issue and stop one-time discount codes tied to a partner's referral link. Coupons are not on for every program: Affitor enables them per program, and they need an agent key that a program Owner has granted `coupons:write`. The program comes from that key; no tool takes a program, account, key or permission argument, and unknown fields are refused.

```json
{
  "mcpServers": {
    "affitor": {
      "command": "npx",
      "args": ["-y", "@affitor/mcp"],
      "env": {
        "AFFITOR_AGENT_KEY": "your_agent_key",
        "AFFITOR_MCP_COUPONS": "1"
      }
    }
  }
}
```

| Tool | Calls | Description |
| ---- | ----- | ----------- |
| `affitor_create_coupon` | `POST /api/v1/coupons` | Create a one-time code for one referral link. Marked destructive. |
| `affitor_lock_coupon` | `POST /api/v1/coupons/:couponId/lock` | Stop new redemptions of one code. It does not delete the coupon, undo applied discounts or refund anyone. Marked destructive. |
| `affitor_get_coupon` | `GET /api/v1/coupons/:couponId` | Read a coupon's status, version and, once active, its code. Read-only. |

**`affitor_create_coupon`**
- `partner_program_id: number`, `referral_link_id: number`: positive ids (1 to 10 digits).
- `product_id: string`: the program's catalogue key, such as `replay`.
- `discount`: exactly one of `{ "kind": "percent", "percent_off_bps": 1..10000, "duration": "once" }` or `{ "kind": "fixed", "amount_off_minor": <cents>, "currency": "usd", "duration": "once" }`.
- `prefix?: string`: up to 12 letters or digits; omit for the default.
- `max_redemptions?: number`: omit for no redemption limit.
- `expires_at?: string`: future UTC ISO time; omit for no expiry.
- `idempotency_key: string`: 8 to 128 of `A-Z a-z 0-9 : _ -`.

**`affitor_lock_coupon`**
- `coupon_id: number`, `expected_version: number`, `idempotency_key: string`.

**`affitor_get_coupon`**
- `coupon_id: number`.

`idempotency_key` is sent as the `Idempotency-Key` header, never in the body. On a timeout or error, retry with the **same key and the same payload**. HTTP 409 means the link already has an existing or pending coupon, the version is stale, or the key was used with another payload: it is never a reason to try a new key.

A pending or held coupon (HTTP 202, or a `pending`, `held` or `lock_pending` status) comes back as a normal result with `"pending": true`: the code is not active yet, so poll `affitor_get_coupon` instead of creating again. Other API errors come back as an MCP error with only `http_status`, the API's `error_code` and `retry_after_seconds` when given.

For your own server, `registerCouponTools(server, createCouponClient(agentKey, apiUrl))` adds the same tools; `registerTools` is unchanged.

## License

MIT
