/**
 * @affitor/recipes — the canonical per-stack payment-tracking recipe registry.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for "how does a brand wire Affitor into
 * their checkout + payment webhook". The CLI (`affitor init`/`onboard`), the MCP
 * server (`affitor_get_integration_plan`), and the docs all read these recipes,
 * so the integration contract can never drift between surfaces. Pure data + pure
 * functions — no runtime dependencies, no network, fully deterministic.
 *
 * A recipe answers, for a given (framework, provider, mode):
 *   1. install      — what to add (`npm i @affitor/sdk`)
 *   2. metadata      — plant attribution at checkout-session creation (always, Stripe)
 *   3. sale          — the trackSale call + WHERE to inject it (s2s/raw only; null for Connect)
 *   4. verify        — the self-verify step (synthetic chain → readiness gate)
 *
 * The `sale_path` is the single anti-double-count decision:
 *   - "connect"     → Stripe Connect autocaptures the sale server-side; inject
 *                     metadata ONLY (sale === null). Never also inject trackSale.
 *   - "webhook_sdk" → inject the trackSale snippet at the framework's webhook site.
 *   - "raw_http"    → sale snippet present, but as a raw call (framework unknown,
 *                     so we can't locate a precise inject site).
 */

export type Framework =
  | "next-app"
  | "next-pages"
  | "fastify"
  | "express"
  | "node"
  | "unknown";

export type Provider = "stripe" | "polar" | "lemonsqueezy" | "paddle" | "unknown";

export type Mode = "stripe_connect" | "s2s";

export type SalePath = "connect" | "webhook_sdk" | "raw_http";

export interface Recipe {
  framework: Framework;
  provider: Provider;
  mode: Mode;
  sale_path: SalePath;
  /** What to install. Always `npm i @affitor/sdk`. */
  install: string;
  /** Checkout-session attribution metadata to plant (always required for Stripe). */
  metadata: { why: string; snippet: string };
  /**
   * The trackSale call + where to inject it. `null` for `sale_path: "connect"`
   * (Stripe Connect records the sale server-side — inject metadata only).
   */
  sale: { snippet: string; inject_target: string } | null;
  /** Self-verify step (run the synthetic chain, poll readiness). */
  verify: string;
  notes?: string;
}

const INSTALL = "npm i @affitor/sdk";

const VERIFY =
  "Run the synthetic chain (POST /api/v1/cli/test-event {type:'chain'}) then poll " +
  "GET /api/v1/programs/me/readiness until integration_verified:true (or read " +
  "gate.next_action to self-correct). Never trust HTTP 200 — verify attribution.";

/**
 * The Stripe checkout-session metadata snippet — plant `affitor_click_id` (from
 * the `affitor_click_id` cookie) + `affitor_customer_key` (your user id) into
 * BOTH `session.metadata` (first payment) AND `subscription_data.metadata`
 * (every renewal — the #1 subscription-attribution bug is forgetting the second).
 */
const STRIPE_METADATA = {
  why:
    "Plant attribution at checkout-session creation so the later sale (in the " +
    "webhook, often a different file days later) can resolve the customer. Set it " +
    "into BOTH session.metadata (covers the first payment, checkout.session.completed) " +
    "AND subscription_data.metadata (covers EVERY renewal, invoice.payment_succeeded — " +
    "renewals lose the click id otherwise).",
  snippet: [
    "// Wherever you create the Checkout Session:",
    "await stripe.checkout.sessions.create({",
    "  // ...existing...",
    "  metadata: {                                  // first payment (checkout.session.completed)",
    "    affitor_click_id: affitorClickId,          // read from the `affitor_click_id` cookie",
    "    affitor_customer_key: user.id,             // your own user id",
    "    program_id: AFFITOR_PROGRAM_ID,",
    "  },",
    "  subscription_data: {                         // REQUIRED for subscriptions — every renewal",
    "    metadata: {",
    "      affitor_click_id: affitorClickId,",
    "      affitor_customer_key: user.id,",
    "      program_id: AFFITOR_PROGRAM_ID,",
    "    },",
    "  },",
    "});",
  ].join("\n"),
};

/** Provider-appropriate metadata note for non-Stripe providers (no Connect path). */
const PROVIDER_METADATA: Record<Exclude<Provider, "stripe">, { why: string; snippet: string }> = {
  polar: {
    why:
      "Plant attribution on the Polar checkout/order so the webhook (order.paid) " +
      "can resolve the customer. Pass your user id as order metadata at checkout creation.",
    snippet: [
      "// When creating the Polar checkout, attach your user id + click id as metadata:",
      "metadata: {",
      "  affitor_click_id: affitorClickId,   // from the `affitor_click_id` cookie",
      "  user_id: user.id,                   // resolved back as order.metadata.user_id",
      "}",
    ].join("\n"),
  },
  lemonsqueezy: {
    why:
      "Plant attribution as Lemon Squeezy checkout custom_data so the webhook " +
      "(order_created) can resolve the customer via meta.custom_data.",
    snippet: [
      "// In the Lemon Squeezy checkout, set custom_data (surfaces as meta.custom_data):",
      "checkout_data: { custom: {",
      "  affitor_click_id: affitorClickId,   // from the `affitor_click_id` cookie",
      "  user_id: user.id,",
      "} }",
    ].join("\n"),
  },
  paddle: {
    why:
      "Plant attribution as Paddle transaction custom_data so the webhook " +
      "(transaction.completed) can resolve the customer via data.custom_data.",
    snippet: [
      "// In the Paddle transaction, set customData (surfaces as data.custom_data):",
      "customData: {",
      "  affitor_click_id: affitorClickId,   // from the `affitor_click_id` cookie",
      "  user_id: user.id,",
      "}",
    ].join("\n"),
  },
  unknown: {
    why:
      "Plant your user id (and the affitor_click_id cookie) onto the payment object " +
      "at checkout creation so your payment webhook can resolve the customer later.",
    snippet: [
      "// At checkout creation, attach your user id + the affitor_click_id cookie",
      "// as provider metadata so the webhook can resolve the customer.",
    ].join("\n"),
  },
};

/** The SDK import prepended to every sale snippet (CLI canonical, named import). */
const SDK_IMPORT = "import { Affitor } from '@affitor/sdk/server';";

/**
 * Per-provider trackSale snippet BODY — lifted verbatim from the CLI's
 * `serverTrackingSnippets()` (packages/cli/src/lib/server-tracking.ts). This
 * registry is the canonical home; the CLI now sources its `sale` from here.
 */
const SALE_SNIPPET_BODY: Record<Provider, string> = {
  polar: [
    "await affitor.trackSale({",
    "  customerExternalId: order.metadata.user_id ?? order.customer_id,",
    "  amount: order.total_amount,        // integer cents",
    "  invoiceId: order.id,",
    "  saleType: order.subscription_id ? 'subscription' : 'payment',",
    "});",
  ].join("\n"),
  lemonsqueezy: [
    "await affitor.trackSale({",
    "  customerExternalId: payload.meta.custom_data?.user_id ?? data.attributes.user_email,",
    "  amount: data.attributes.total,     // integer cents",
    "  invoiceId: String(data.id),",
    "});",
  ].join("\n"),
  paddle: [
    "await affitor.trackSale({",
    "  customerExternalId: data.custom_data?.user_id,",
    "  amount: Number(data.details.totals.total),   // cents",
    "  invoiceId: data.id,",
    "});",
  ].join("\n"),
  stripe: [
    "await affitor.trackSale({",
    "  customerExternalId: session.client_reference_id,",
    "  amount: session.amount_total,      // cents",
    "  invoiceId: session.id,",
    "});",
  ].join("\n"),
  unknown: [
    "await affitor.trackSale({",
    "  customerExternalId: user.id,",
    "  amount: amountInCents,",
    "  invoiceId: transactionId,",
    "});",
  ].join("\n"),
};

/**
 * Framework-specific injection-site hint (mirrors webhook-detect.ts handlerHintFor).
 * Where the trackSale call belongs — always after the Stripe webhook is verified.
 */
const INJECT_TARGET: Record<Framework, string> = {
  "next-app":
    "app/api/webhooks/stripe/route.ts POST handler, after stripe.webhooks.constructEvent",
  "next-pages": "pages/api/webhooks/stripe.ts handler, after constructEvent",
  fastify: "the fastify.post('/webhooks/stripe', …) handler, after constructEvent",
  express:
    "the app.post('/webhooks/stripe', express.raw(...), …) handler, after constructEvent",
  node: "the file calling stripe.webhooks.constructEvent, in the matched event case",
  unknown: "your payment webhook handler, when a payment succeeds",
};

/** The full sale snippet (SDK import + provider body) for a given provider. */
function saleSnippetFor(provider: Provider): string {
  return `${SDK_IMPORT}\n\n${SALE_SNIPPET_BODY[provider]}`;
}

/** The attribution metadata block for a given provider. */
function metadataFor(provider: Provider): { why: string; snippet: string } {
  return provider === "stripe" ? STRIPE_METADATA : PROVIDER_METADATA[provider];
}

/**
 * Resolve the canonical recipe for a stack. Deterministic + pure.
 *
 * sale_path rules:
 *   - mode "stripe_connect" → "connect" (Stripe Connect autocaptures; sale === null,
 *     metadata only — agent is forbidden from also injecting trackSale).
 *   - mode "s2s"            → "webhook_sdk" (inject trackSale at the framework site)…
 *   - …but framework "unknown" → "raw_http" (sale present, but a raw call — no
 *     precise inject site to locate).
 */
export function getRecipe(framework: Framework, provider: Provider, mode: Mode): Recipe {
  let sale_path: SalePath;
  if (mode === "stripe_connect") {
    sale_path = "connect";
  } else {
    sale_path = framework === "unknown" ? "raw_http" : "webhook_sdk";
  }

  const sale =
    sale_path === "connect"
      ? null
      : { snippet: saleSnippetFor(provider), inject_target: INJECT_TARGET[framework] };

  const notes =
    sale_path === "connect"
      ? "Stripe Connect records the sale server-side via Affitor's own webhook — inject the metadata ONLY, never also call trackSale (double-count guard)."
      : sale_path === "raw_http"
        ? "Framework not detected — inject the trackSale call as a raw call at your webhook handler; no precise inject site could be located."
        : undefined;

  return {
    framework,
    provider,
    mode,
    sale_path,
    install: INSTALL,
    metadata: metadataFor(provider),
    sale,
    verify: VERIFY,
    ...(notes ? { notes } : {}),
  };
}

/**
 * Build an ordered, human + agent readable integration plan for a stack.
 * Mode defaults to "stripe_connect". Pure.
 *
 * Steps: detect → install → metadata → sale (if any) → verify.
 */
export function getIntegrationPlan(input: {
  framework: Framework;
  provider: Provider;
  mode?: Mode;
}): { steps: string[]; recipe: Recipe } {
  const mode = input.mode ?? "stripe_connect";
  const recipe = getRecipe(input.framework, input.provider, mode);

  const steps: string[] = [
    `1. Detect: framework=${recipe.framework}, provider=${recipe.provider}, mode=${recipe.mode}, sale_path=${recipe.sale_path}.`,
    `2. Install: ${recipe.install}`,
    `3. Metadata: plant attribution at checkout-session creation. ${recipe.metadata.why}`,
  ];

  let n = 4;
  if (recipe.sale) {
    steps.push(
      `${n}. Sale: inject the trackSale call into ${recipe.sale.inject_target}.`,
    );
    n += 1;
  } else {
    steps.push(
      `${n}. Sale: none — sale_path is "connect"; Stripe Connect records the sale server-side. Do NOT inject trackSale.`,
    );
    n += 1;
  }

  steps.push(`${n}. Verify: ${recipe.verify}`);

  return { steps, recipe };
}
