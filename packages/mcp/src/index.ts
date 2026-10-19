#!/usr/bin/env node
/**
 * @affitor/mcp — Model Context Protocol (MCP) stdio server for Affitor.
 *
 * Exposes Affitor's affiliate-tracking capabilities as MCP tools so AI agents
 * (Claude Desktop, Cursor, …) can report clicks, leads, sales and refunds, and
 * poll integration readiness — all over the standard MCP stdio transport.
 *
 * It wraps the consolidated server client `@affitor/sdk/server` (the `Affitor`
 * class). Auth is the program API key, read from the `AFFITOR_API_KEY` env var.
 *
 * The two tools that move money (`affitor_track_sale`, `affitor_track_refund`)
 * are only registered when `AFFITOR_MCP_WRITE=1`: an agent exploring tools must
 * not be able to create a real sale or reverse a commission by accident. Every
 * tool carries MCP annotations so clients can ask before a write.
 *
 * The coupon tools (`affitor_create_coupon`, `affitor_lock_coupon`,
 * `affitor_get_coupon`) are a separate family: they use only `AFFITOR_AGENT_KEY`
 * and are registered only when `AFFITOR_MCP_COUPONS=1`. Either family can run
 * without the other's key.
 *
 *   {
 *     "mcpServers": {
 *       "affitor": {
 *         "command": "npx",
 *         "args": ["-y", "@affitor/mcp"],
 *         "env": { "AFFITOR_API_KEY": "your_program_key" }
 *       }
 *     }
 *   }
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Affitor } from '@affitor/sdk/server';
import { getIntegrationPlan } from '@affitor/recipes';

/**
 * The subset of the `Affitor` client the MCP tools depend on. Declaring it here
 * lets the tool handlers be unit-tested with a stubbed client.
 */
export interface AffitorLike {
  readiness: Affitor['readiness'];
  trackLead: Affitor['trackLead'];
  trackSale: Affitor['trackSale'];
  trackRefund: Affitor['trackRefund'];
  trackClick: Affitor['trackClick'];
}

/** JSON-stringify a value for text content (pretty for readability by agents). */
function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Wrap a successful result as MCP text content. */
function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: asText(value) }] };
}

/** Wrap an error message as an MCP error result. */
function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Run an `Affitor` client call and normalise both failure shapes:
 *   - a thrown error (e.g. `readiness()` throws `AffitorApiError` on non-2xx)
 *   - a resolved `{ ok: false, error }` envelope (the `track*` methods)
 * into an MCP `isError` result; otherwise return the JSON payload as text.
 */
async function runCall(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = (await fn()) as { ok?: boolean; error?: string } | unknown;
    if (result && typeof result === 'object' && 'ok' in result && (result as { ok?: boolean }).ok === false) {
      const err = (result as { error?: string }).error;
      return fail(err || 'Affitor request failed');
    }
    return ok(result);
  } catch (err) {
    return fail((err as Error)?.message || 'Affitor request failed');
  }
}

/**
 * Fires Affitor's synthetic verification chain and resolves to the parsed body.
 * Injected into `registerTools` so the `affitor_run_verification` handler stays
 * unit-testable without a real network call.
 */
export type RunVerification = () => Promise<unknown>;

/**
 * POST `{base}/api/v1/cli/test-event` with `{ type: 'chain' }` to fire the
 * synthetic click→lead→sale verification chain through Affitor's REAL
 * attribution pipeline (isolated `is_test` rows).
 *
 * Returns the parsed JSON body for a 2xx response. For a non-2xx (including a
 * 429 rate-limit), returns the parsed error body with the HTTP status merged in
 * (`{ http_status, ...body }`) so the agent can read `retry_after_seconds` and
 * back off — it does NOT throw on 429. Throws only on a network or JSON-parse
 * failure, which `runCall` converts into an MCP error result.
 */
export async function fireVerificationChain(apiKey: string, apiUrl: string): Promise<unknown> {
  const res = await fetch(`${apiUrl}/api/v1/cli/test-event`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'chain' }),
  });

  const body = (await res.json()) as Record<string, unknown>;

  if (res.ok) {
    return body;
  }

  // Non-2xx (incl. 429): merge the HTTP status in so the agent can read
  // retry_after_seconds and back off rather than crash.
  return { http_status: res.status, ...body };
}

/** The sale fields a test sale sends; same names as `affitor_track_sale`. */
export interface TestSaleInput {
  customerExternalId?: string;
  clickId?: string;
  amount: number;
  invoiceId: string;
  currency?: string;
  saleType?: 'payment' | 'subscription';
  isRecurring?: boolean;
  subscriptionId?: string;
  subscriptionInterval?: 'monthly' | 'quarterly' | 'annual';
}

/** Records a test sale (`is_test`, no commission). Injected so it stays unit-testable. */
export type TrackTestSale = (input: TestSaleInput) => Promise<unknown>;

export interface RegisterOptions {
  /** Register the money-moving tools (`affitor_track_sale`, `affitor_track_refund`). */
  allowWrites?: boolean;
  /** Used by `affitor_track_sale` when `testMode` is true. */
  trackTestSale?: TrackTestSale;
}

/**
 * POST `{base}/api/v1/track/sale` with `additional_data.test_mode`, which the API
 * records as an `is_test` sale with no commission. The SDK's `trackSale` has no
 * test-mode field, so this call is made directly, like `fireVerificationChain`.
 * Resolves to the SDK-shaped `{ ok, status, data }` so `runCall` treats both alike.
 *
 * The transaction id is sent as `test_<invoiceId>`: the API's duplicate check does
 * not skip test rows, so a test sale under the real id would make the real sale
 * with that invoice answer 409 and never create its commission.
 */
export const TEST_TRANSACTION_PREFIX = 'test_';

export async function postTestSale(apiKey: string, apiUrl: string, input: TestSaleInput): Promise<unknown> {
  const body: Record<string, unknown> = {
    customer_key: input.customerExternalId,
    click_id: input.clickId,
    amount_cents: input.amount,
    transaction_id: `${TEST_TRANSACTION_PREFIX}${input.invoiceId}`,
    currency: input.currency,
    sale_type: input.saleType,
    is_recurring: input.isRecurring,
    subscription_id: input.subscriptionId,
    subscription_interval: input.subscriptionInterval,
    additional_data: { test_mode: true },
  };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];

  const res = await fetch(`${apiUrl}/api/v1/track/sale`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const error = res.ok ? undefined : String((data && (data.error as string)) || `HTTP ${res.status}`);
  return { ok: res.ok, status: res.status, data, ...(error ? { error } : {}) };
}

/**
 * Register the Affitor tools on an MCP server. Exported for unit testing the
 * handlers with a stubbed `Affitor` client.
 *
 * Always registered (5): readiness, track_lead, track_click, the PURE
 * `affitor_get_integration_plan` (reads `@affitor/recipes`, no client, no
 * network) and `affitor_run_verification`, which fires the synthetic
 * verification chain via the injected `runVerification` (omitted → a "not
 * configured" failure). With `allowWrites` (2 more): track_sale and track_refund.
 */
export function registerTools(
  server: McpServer,
  affitor: AffitorLike,
  runVerification?: RunVerification,
  options: RegisterOptions = {},
): void {
  server.registerTool(
    'affitor_readiness',
    {
      description:
        "Check how close this program is to tracking real affiliate sales. Use it first to see what to fix, and after affitor_run_verification, every poll.retry_after_seconds until integration_verified is true. Returns state, integration_verified, blocker (the first failing gate), each gate (profile, economics, payout, tracking, live) with status and next_action, last event times and 24-hour counts.",
      inputSchema: {
        forceRecheck: z
          .boolean()
          .optional()
          .describe("Run the checks again now, including a fetch of your site to find the tracker. Leave it out to get the last saved result, which is enough while polling."),
      },
      // Reads only, but the server-side check fetches the brand's own site to look for the tracker.
      annotations: { title: 'Check readiness', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => runCall(() => affitor.readiness({ forceRecheck: args.forceRecheck })),
  );

  server.registerTool(
    'affitor_track_lead',
    {
      description:
        'Record a signup for this program and bind the customer to the affiliate click that brought them, so their later sales attribute from customerExternalId alone. Use it when a referred visitor creates an account, from your server. Send customerExternalId, clickId, or both. Returns { ok, status, data } from the API, or an error naming what is missing.',
      inputSchema: {
        customerExternalId: z
          .string()
          .optional()
          .describe("Your app's own id for this customer, such as user_123. It binds the customer to the click, so their later sales need only this id. Send it, clickId, or both."),
        clickId: z
          .string()
          .optional()
          .describe('The click id the Affitor tracker stored in the visitor\'s affitor_click_id cookie. Send it, customerExternalId, or both; with neither, the lead cannot be attributed.'),
        email: z.string().optional().describe("The customer's email address, stored with the lead. Leave it out to record the lead without one."),
        testMode: z
          .boolean()
          .optional()
          .describe('True records a test lead (marked is_test, never counted or paid) while you check an integration. Leave it out to record a real lead.'),
      },
      annotations: { title: 'Report a lead', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      if (!args.customerExternalId && !args.clickId) {
        return fail('affitor_track_lead: `customerExternalId` or `clickId` is required');
      }
      return runCall(() =>
        affitor.trackLead({
          customerExternalId: args.customerExternalId,
          clickId: args.clickId,
          email: args.email,
          ...(args.testMode ? { additionalData: { test_mode: true } } : {}),
        }),
      );
    },
  );

  if (options.allowWrites) registerWriteTools(server, affitor, options.trackTestSale);

  server.registerTool(
    'affitor_track_click',
    {
      description:
        'Record a visit that arrived through an affiliate link. Use it only to track clicks from a server; the Affitor browser tracker does this on its own. Returns { ok, status, data }, where data holds click_id (store it in the affitor_click_id cookie), partner_code and cookie_window_days.',
      inputSchema: {
        affiliateUrl: z
          .string()
          .optional()
          .describe("The full link the visitor arrived on, carrying the partner code in ?aff= (or ?via=), such as https://example.com/?aff=maya. The API needs it to find the partner; without it the call fails."),
        pageUrl: z.string().optional().describe('The page the visitor landed on, if it differs from affiliateUrl. Leave it out to record affiliateUrl as the landing page.'),
        referrerUrl: z.string().optional().describe('The page that linked to you (the HTTP Referer), stored with the click to show where traffic came from. Leave it out when there is none.'),
        existingClickId: z
          .string()
          .optional()
          .describe("The visitor's current affitor_click_id, so a repeat visit keeps the same click id. Send only an id that this program's tracker set. Leave it out to get a new one."),
      },
      annotations: { title: 'Report a click', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      runCall(() =>
        affitor.trackClick({
          affiliateUrl: args.affiliateUrl,
          pageUrl: args.pageUrl,
          referrerUrl: args.referrerUrl,
          existingClickId: args.existingClickId,
        }),
      ),
  );
  server.registerTool(
    'affitor_get_integration_plan',
    {
      description:
        'Get the exact steps to connect a payment stack to Affitor: the install, the checkout metadata snippet, the trackSale snippet and the file it goes in, and the check that proves it works. Use it before writing integration code, instead of guessing the contract. Works offline: it reads a built-in recipe list and calls no API.',
      inputSchema: {
        framework: z
          .enum(['next-app', 'next-pages', 'fastify', 'express', 'node', 'unknown'])
          .describe("The app's framework, read from its package.json and folders: next-app (app/ router), next-pages (pages/ router), fastify, express, node, or unknown. It decides which file the sale snippet goes in."),
        provider: z
          .enum(['stripe', 'polar', 'lemonsqueezy', 'paddle', 'unknown'])
          .default('stripe')
          .describe('The payment provider the app checks out with, read from its dependencies. Leave it out for stripe.'),
        mode: z
          .enum(['stripe_connect', 's2s'])
          .optional()
          .default('stripe_connect')
          .describe(
            "How sales reach Affitor. stripe_connect: the brand's connected Stripe account reports sales, so the plan only adds checkout metadata. s2s: your payment webhook calls trackSale. Leave it out for stripe_connect.",
          ),
      },
      annotations: { title: 'Get the integration plan', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      // Pure: reads the canonical recipe registry. No SDK client, no network.
      const plan = getIntegrationPlan({
        framework: args.framework,
        provider: args.provider,
        mode: args.mode,
      });
      return ok(plan);
    },
  );

  server.registerTool(
    'affitor_run_verification',
    {
      description:
        "Prove the integration works: send a test click, lead and sale through Affitor's real attribution pipeline, recorded as is_test rows that are never paid. Use it after setup, then poll affitor_readiness until integration_verified is true. Limited to 10 runs per program per hour; on rate_limited, wait retry_after_seconds. Returns the API response, with http_status added on an error.",
      inputSchema: {},
      annotations: { title: 'Run the verification chain', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      if (!runVerification) {
        return fail('affitor_run_verification is not configured in this MCP build');
      }
      return runCall(() => runVerification());
    },
  );
}

/**
 * The two tools that move money. Registered only with `allowWrites`
 * (`AFFITOR_MCP_WRITE=1`). `testMode` records an `is_test` sale with no
 * commission; for refunds the API has no test mode, so `testMode` returns what
 * would be sent without calling it.
 */
function registerWriteTools(server: McpServer, affitor: AffitorLike, trackTestSale?: TrackTestSale): void {
  server.registerTool(
    'affitor_track_sale',
    {
      description:
        "Record a sale and the affiliate commission it earns. Use it from your payment webhook when a referred customer pays. It creates a real sale and commission unless testMode is true. Attribution comes from customerExternalId (bound by affitor_track_lead) or clickId. Retrying with the same invoiceId never records a second sale. Returns { ok, status, data } from the API.",
      inputSchema: {
        customerExternalId: z
          .string()
          .optional()
          .describe("Your app's id for the paying customer, the same one sent to affitor_track_lead. Once bound, it alone attributes the sale. Send it, clickId, or both."),
        clickId: z.string().optional().describe("The visitor's affitor_click_id, for a sale with no earlier lead. Send it, customerExternalId, or both."),
        amount: z.number().int().positive().describe('What the customer paid, in the smallest currency unit, such as 4999 for $49.99.'),
        invoiceId: z.string().min(1).describe("Your payment provider's invoice or charge id, such as in_1Q2w3E. A retry with the same id is recognised and not counted twice; affitor_track_refund uses it too."),
        currency: z.string().optional().describe('The three-letter currency of amount, such as USD or EUR. Leave it out for USD.'),
        saleType: z.enum(['payment', 'subscription']).optional().describe('payment for a one-off purchase, subscription for a plan the customer pays for again. Leave it out for payment.'),
        isRecurring: z.boolean().optional().describe('True when this is a renewal of an earlier subscription sale, not the first payment. Leave it out for a first payment.'),
        subscriptionId: z.string().optional().describe("The provider's subscription id, such as sub_1Q2w3E, so renewals group under one subscription. Leave it out for a one-off payment."),
        subscriptionInterval: z
          .enum(['monthly', 'quarterly', 'annual'])
          .optional()
          .describe('How often the subscription bills. Leave it out for a one-off payment.'),
        testMode: z
          .boolean()
          .optional()
          .describe('True records a test sale (marked is_test, no commission) under test_ plus the invoiceId, so the real sale can still be recorded later. Leave it out for a real sale.'),
      },
      annotations: { title: 'Report a sale', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      if (!args.customerExternalId && !args.clickId) {
        return fail('affitor_track_sale: `customerExternalId` or `clickId` is required');
      }
      const input: TestSaleInput = {
        customerExternalId: args.customerExternalId,
        clickId: args.clickId,
        amount: args.amount,
        invoiceId: args.invoiceId,
        currency: args.currency,
        saleType: args.saleType,
        isRecurring: args.isRecurring,
        subscriptionId: args.subscriptionId,
        subscriptionInterval: args.subscriptionInterval,
      };
      if (args.testMode) {
        if (!trackTestSale) return fail('affitor_track_sale: testMode is not configured in this MCP build');
        return runCall(() => trackTestSale(input));
      }
      return runCall(() => affitor.trackSale(input));
    },
  );

  server.registerTool(
    'affitor_track_refund',
    {
      description:
        "Record a refund on a sale and adjust its affiliate commission: refunding everything left reverses the commission, a partial refund is recorded against it. Use it from your payment webhook when you refund a customer. A retry with the same invoiceId and amount is ignored. Returns { ok, status, data } from the API; with testMode, the refund it would send, without calling the API.",
      inputSchema: {
        invoiceId: z.string().min(1).describe('The invoiceId the sale was recorded with in affitor_track_sale, such as in_1Q2w3E.'),
        refundAmountCents: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("This refund's amount, in the sale currency's smallest unit, such as 1500 for $15.00; it adds to earlier refunds on the sale, up to the sale amount. Leave it out to refund everything left, which reverses the commission; never send 0."),
        refundReason: z.string().optional().describe('Why the customer was refunded, in your words, stored with the refund. Leave it out to record no reason.'),
        testMode: z
          .boolean()
          .optional()
          .describe('True returns the refund that would be sent and calls nothing. Leave it out to record the refund.'),
      },
      annotations: { title: 'Report a refund', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const input = {
        invoiceId: args.invoiceId,
        refundAmountCents: args.refundAmountCents,
        refundReason: args.refundReason,
      };
      if (args.testMode) return ok({ dry_run: true, would_send: input });
      return runCall(() => affitor.trackRefund(input));
    },
  );
}

/** One coupon API call: the route, an optional JSON body and the caller's Idempotency-Key. */
export interface CouponRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}

/** The HTTP status, the parsed JSON body (null if none) and the Retry-After header if sent. */
export interface CouponResponse {
  status: number;
  body: unknown;
  retryAfter?: string;
}

/** Sends one coupon API call. Injected into `registerCouponTools` so it stays unit-testable. */
export type CouponClient = (request: CouponRequest) => Promise<CouponResponse>;

/**
 * A coupon client bound to the agent key (`AFFITOR_AGENT_KEY`) and the API base.
 * It never sees the program key, and the Idempotency-Key goes only in the header.
 */
export function createCouponClient(agentKey: string, apiUrl: string): CouponClient {
  return async ({ method, path, body, idempotencyKey }) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${agentKey}`, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetch(`${apiUrl}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const parsed: unknown = await res.json().catch(() => null);
    const retryAfter = res.headers.get('Retry-After');
    return { status: res.status, body: parsed, ...(retryAfter ? { retryAfter } : {}) };
  };
}

const PENDING_STATUSES = new Set(['pending', 'held', 'lock_pending']);
const SAME_KEY_HINT =
  'Retry only with the same idempotency_key and the same payload. A 409 means an existing or pending assignment for that link, a stale version, or a key already used with another payload; it is never a reason to try a new key.';

/**
 * Map a coupon API response to an MCP result. A 2xx body is returned as JSON text;
 * a 202 or a pending/held/lock_pending body is marked pending (not an error, not an
 * active code). Any other status becomes an error carrying only the HTTP status, the
 * API's stable error.code and retry info: no API message, request args or key.
 */
function couponResult(res: CouponResponse): CallToolResult {
  const body = (res.body && typeof res.body === 'object' ? res.body : {}) as Record<string, unknown>;
  const data = body.data as { status?: unknown } | undefined;
  if (res.status === 202 || (res.status >= 200 && res.status < 300 && PENDING_STATUSES.has(String(data?.status)))) {
    return ok({
      pending: true,
      http_status: res.status,
      next_action: 'Not an active code yet. Poll affitor_get_coupon with this coupon_id; do not send a new create or lock.',
      ...body,
    });
  }
  if (res.status >= 200 && res.status < 300) return ok(res.body);

  const error = body.error as { code?: unknown; retry_after_seconds?: unknown } | undefined;
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'unknown_error';
  const retryAfter = typeof error?.retry_after_seconds === 'number' ? error.retry_after_seconds : Number(res.retryAfter);
  return {
    content: [
      {
        type: 'text',
        text: asText({
          http_status: res.status,
          error_code: code,
          ...(Number.isFinite(retryAfter) ? { retry_after_seconds: retryAfter } : {}),
          ...(res.status === 409 ? { hint: SAME_KEY_HINT } : {}),
        }),
      },
    ],
    isError: true,
  };
}

/** Run a coupon call; a network failure becomes a generic error with no request details. */
async function runCouponCall(client: CouponClient, request: CouponRequest): Promise<CallToolResult> {
  try {
    return couponResult(await client(request));
  } catch {
    return fail(asText({ error_code: 'request_failed', ...(request.idempotencyKey ? { hint: SAME_KEY_HINT } : {}) }));
  }
}

// v1 resource ids: positive integers of 1..10 digits.
const v1Id = () => z.number().int().min(1).max(9_999_999_999);
const safePositiveInt = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const idempotencyKey = () =>
  z
    .string()
    .regex(/^[A-Za-z0-9:_-]{8,128}$/)
    .describe(
      'A key you choose for this one request, 8 to 128 of A-Z a-z 0-9 : _ -, such as cpn_link82_v1. Sent as the Idempotency-Key header. Keep it, and on any retry send the same key with the same payload.',
    );

/**
 * Register the coupon tools (create, lock, get) on an MCP server. They act only in
 * the program of the agent key behind `couponClient`; no tool takes a program,
 * account, key or permission argument. Every input object is strict.
 */
export function registerCouponTools(server: McpServer, couponClient: CouponClient): void {
  server.registerTool(
    'affitor_create_coupon',
    {
      description:
        "Create a one-time discount code for one partner's referral link in this agent key's program. Use it when a partner needs a coupon for their link. Retry with the same idempotency_key and the same payload. HTTP 409 means the link has an existing or pending coupon, or the key was used with another payload; never try a new key. Returns the coupon status; pending means poll affitor_get_coupon.",
      inputSchema: z
        .object({
          partner_program_id: v1Id().describe("The partner's enrollment id in this program, from Affitor. It must own referral_link_id."),
          referral_link_id: v1Id().describe("The id of the partner's referral link the code is tied to, from Affitor. A link holds at most one coupon."),
          product_id: z
            .string()
            .min(1)
            .describe("The program's catalogue key for the product the discount applies to, such as replay. Affitor maps it to the real product; never a Stripe prod_ or price_ id."),
          discount: z
            .discriminatedUnion('kind', [
              z
                .object({
                  kind: z.literal('percent'),
                  percent_off_bps: z.number().int().min(1).max(10000).describe('The percent off in basis points, 1 to 10000, such as 1000 for 10%.'),
                  duration: z.literal('once').describe('Always once: the discount applies to one checkout.'),
                })
                .strict(),
              z
                .object({
                  kind: z.literal('fixed'),
                  amount_off_minor: safePositiveInt().describe('The amount off in cents, such as 500 for $5.00.'),
                  currency: z.literal('usd').describe('Always usd.'),
                  duration: z.literal('once').describe('Always once: the discount applies to one checkout.'),
                })
                .strict(),
            ])
            .describe('Exactly one discount: kind percent with percent_off_bps, or kind fixed with amount_off_minor and currency usd.'),
          prefix: z
            .string()
            .regex(/^[A-Za-z0-9]{0,12}$/)
            .optional()
            .describe('Up to 12 letters or digits that start the code, such as BTO. Leave it out for the default prefix.'),
          max_redemptions: safePositiveInt()
            .optional()
            .describe('How many checkouts may use the code in total. Leave it out for no redemption limit.'),
          expires_at: z
            .string()
            .datetime()
            .optional()
            .describe('When the code stops working, a future UTC ISO time such as 2026-11-30T00:00:00Z. Leave it out for no expiry.'),
          idempotency_key: idempotencyKey(),
        })
        .strict(),
      annotations: { title: 'Create a coupon', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ idempotency_key, ...body }) =>
      runCouponCall(couponClient, { method: 'POST', path: '/api/v1/coupons', body, idempotencyKey: idempotency_key }),
  );

  server.registerTool(
    'affitor_lock_coupon',
    {
      description:
        'Stop new redemptions of one coupon code. It does not delete the coupon, undo discounts already applied or refund anyone. Retry with the same idempotency_key and the same payload. HTTP 409 means a stale expected_version, an existing or pending assignment, or the key was used with another payload; never try a new key. Returns the coupon status; lock_pending means poll affitor_get_coupon.',
      inputSchema: z
        .object({
          coupon_id: v1Id().describe('The coupon_id returned by affitor_create_coupon or affitor_get_coupon.'),
          expected_version: safePositiveInt().describe('The version from the latest affitor_get_coupon or create result. A stale version answers 409.'),
          idempotency_key: idempotencyKey(),
        })
        .strict(),
      annotations: { title: 'Lock a coupon', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ coupon_id, expected_version, idempotency_key }) =>
      runCouponCall(couponClient, {
        method: 'POST',
        path: `/api/v1/coupons/${coupon_id}/lock`,
        body: { expected_version },
        idempotencyKey: idempotency_key,
      }),
  );

  server.registerTool(
    'affitor_get_coupon',
    {
      description:
        "Read one coupon's status (pending, active, lock_pending, locked, held or failed), version and, once active, its code. Use it to poll after create or lock answers pending, instead of calling them again. Returns the coupon status from the API; a code works only when status is active.",
      inputSchema: z
        .object({
          coupon_id: v1Id().describe('The coupon_id returned by affitor_create_coupon.'),
        })
        .strict(),
      annotations: { title: 'Get a coupon', readOnlyHint: true, openWorldHint: true },
    },
    async ({ coupon_id }) => runCouponCall(couponClient, { method: 'GET', path: `/api/v1/coupons/${coupon_id}` }),
  );
}

/** Read the server version from this package's package.json at runtime. */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // dist/index.js → ../package.json
    const pkg = require('../package.json') as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SERVER_VERSION = readVersion();

async function main(): Promise<void> {
  // Two independent families, each with its own key; neither key ever falls back to the other.
  const apiKey = process.env.AFFITOR_API_KEY;
  const agentKey = process.env.AFFITOR_AGENT_KEY;
  const couponsOn = process.env.AFFITOR_MCP_COUPONS === '1';
  if (!apiKey && !(agentKey && couponsOn)) {
    process.stderr.write(
      '@affitor/mcp: set AFFITOR_API_KEY (program key, tracking tools), or AFFITOR_AGENT_KEY with AFFITOR_MCP_COUPONS=1 (coupon tools), in your MCP client config, e.g.\n' +
        '  "env": { "AFFITOR_API_KEY": "your_program_key" }\n',
    );
    process.exit(1);
  }
  if (couponsOn && !agentKey) {
    process.stderr.write('@affitor/mcp: AFFITOR_MCP_COUPONS=1 needs AFFITOR_AGENT_KEY; coupon tools are not added.\n');
  }

  const apiUrl = process.env.AFFITOR_API_URL;
  const baseUrl = apiUrl ?? 'https://api.affitor.com';
  const server = new McpServer({ name: 'affitor', version: SERVER_VERSION });

  if (apiKey) {
    const affitor = new Affitor({ apiKey, ...(apiUrl ? { apiUrl } : {}) });

    // Chain-firing isn't exposed by the SDK client (its `post` is private), so we
    // fire the endpoint via a small authenticated fetch, injected for testability.
    const runVerification: RunVerification = () => fireVerificationChain(apiKey, baseUrl);

    // AFFITOR_MCP_WRITE=1 registers the tools that move money (track_sale, track_refund).
    registerTools(server, affitor, runVerification, {
      allowWrites: process.env.AFFITOR_MCP_WRITE === '1',
      trackTestSale: (input) => postTestSale(apiKey, baseUrl, input),
    });
  }

  // AFFITOR_MCP_COUPONS=1 with AFFITOR_AGENT_KEY registers the coupon tools.
  if (agentKey && couponsOn) registerCouponTools(server, createCouponClient(agentKey, baseUrl));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Only auto-start the server when this module is the process entrypoint (i.e.
 * run as the `affitor-mcp` bin). When imported (e.g. by tests to exercise
 * `registerTools`), do nothing so the importer controls the lifecycle.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const thisPath = fileURLToPath(import.meta.url);
    const entryPath = resolve(entry);
    // Match `node dist/index.js` exactly, and `affitor-mcp` bin symlinks that
    // resolve to this same realpath.
    return thisPath === entryPath || realpathSafe(thisPath) === realpathSafe(entryPath);
  } catch {
    return false;
  }
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`@affitor/mcp: fatal error — ${(err as Error)?.message || String(err)}\n`);
    process.exit(1);
  });
}
