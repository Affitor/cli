# @affitor/recipes

The **canonical per-stack payment-tracking recipe registry** for [Affitor](https://affitor.com).

This package is the **single source of truth** for "how does a brand wire Affitor
into their checkout and payment webhook". The CLI (`affitor init` / `affitor onboard`),
the MCP server (`affitor_get_integration_plan`), and the docs all read these recipes,
so the integration contract can never drift between surfaces.

It is pure data and pure functions — **no runtime dependencies, no network, fully
deterministic**. This is a concept / contract reference; it is not an end-user
install guide (use the CLI or MCP server to actually integrate).

## What a recipe answers

For a given `(framework, provider, mode)`, a recipe describes the four-step
integration contract:

1. **install** — what to add (`npm i @affitor/sdk`).
2. **metadata** — attribution to plant at checkout-session creation (always, for Stripe).
3. **sale** — the `trackSale` call + **where** to inject it (`s2s` / raw only; `null` for Stripe Connect, which autocaptures the sale server-side).
4. **verify** — the self-verify step (fire the synthetic chain, then poll readiness).

The `sale_path` is the single anti-double-count decision:

- `"connect"` — Stripe Connect autocaptures the sale server-side; inject **metadata only** (`sale === null`). Never also inject `trackSale`.
- `"webhook_sdk"` — inject the `trackSale` snippet at the framework's webhook site.
- `"raw_http"` — sale snippet present, but as a raw call (framework unknown, so no precise inject site).

## Exports

### `getRecipe(framework, provider, mode): Recipe`

Resolve the canonical recipe for a single stack. Deterministic and pure.

```ts
import { getRecipe } from "@affitor/recipes";

const recipe = getRecipe("next-app", "stripe", "s2s");
// recipe.sale_path  → "webhook_sdk"
// recipe.install    → "npm i @affitor/sdk"
// recipe.metadata   → { why, snippet }   (plant at checkout-session creation)
// recipe.sale       → { snippet, inject_target }   (null for "stripe_connect")
// recipe.renewal    → { snippet, inject_target, note }   (Stripe non-Connect only)
// recipe.verify     → "Run the synthetic chain … then poll readiness …"
```

### `getIntegrationPlan(input): { steps: string[]; recipe: Recipe }`

Build an ordered, human- and agent-readable plan (detect → install → metadata →
sale → renewals → verify) plus the underlying `Recipe`. `mode` defaults to
`"stripe_connect"`.

```ts
import { getIntegrationPlan } from "@affitor/recipes";

const { steps, recipe } = getIntegrationPlan({
  framework: "fastify",
  provider: "stripe",
  mode: "s2s",
});
// steps[0] → "1. Detect: framework=fastify, provider=stripe, mode=s2s, sale_path=webhook_sdk."
// steps[1] → "2. Install: npm i @affitor/sdk"
// …
```

This is exactly what the MCP `affitor_get_integration_plan` tool returns.

## Types

```ts
type Framework = "next-app" | "next-pages" | "fastify" | "express" | "node" | "unknown";
type Provider  = "stripe" | "polar" | "lemonsqueezy" | "paddle" | "unknown";
type Mode      = "stripe_connect" | "s2s";
type SalePath  = "connect" | "webhook_sdk" | "raw_http";
```

The `Recipe` and `SalePath` types are exported alongside the functions. See the
inline doc comments in the source for the full `Recipe` shape.

## License

MIT
