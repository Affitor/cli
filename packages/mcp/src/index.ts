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
 */
export async function postTestSale(apiKey: string, apiUrl: string, input: TestSaleInput): Promise<unknown> {
  const body: Record<string, unknown> = {
    customer_key: input.customerExternalId,
    click_id: input.clickId,
    amount_cents: input.amount,
    transaction_id: input.invoiceId,
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
        "Check this program's integration/onboarding readiness — returns a 5-gate verdict + blocker + next_action. Poll until integration_verified is true.",
      inputSchema: {
        forceRecheck: z
          .boolean()
          .optional()
          .describe('Force a fresh server-side recheck instead of returning the cached verdict.'),
      },
      annotations: { title: 'Check readiness', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => runCall(() => affitor.readiness({ forceRecheck: args.forceRecheck })),
  );

  server.registerTool(
    'affitor_track_lead',
    {
      description:
        'Report a lead/signup. Binds the customer to the click so later sales attribute by customerExternalId alone.',
      inputSchema: {
        customerExternalId: z
          .string()
          .optional()
          .describe("Advertiser's own user id — binds this customer to the click. One of customerExternalId / clickId is required."),
        clickId: z
          .string()
          .optional()
          .describe('Affitor click id (from the `affitor_click_id` cookie). One of clickId / customerExternalId is required.'),
        email: z.string().optional().describe("The lead's email address."),
        testMode: z
          .boolean()
          .optional()
          .describe('Record a test lead (is_test) instead of a real one.'),
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
      description: 'Report a click (usually browser-side; public, no customer needed).',
      inputSchema: {
        affiliateUrl: z.string().optional().describe('The affiliate/referral URL that was clicked.'),
        pageUrl: z.string().optional().describe('The landing page URL the click arrived on.'),
        referrerUrl: z.string().optional().describe('The HTTP referrer URL, if any.'),
        existingClickId: z.string().optional().describe('Reuse an existing Affitor click id instead of minting a new one.'),
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
        'Return the deterministic Affitor payment-tracking integration plan for a given stack — the install, the checkout-metadata snippet, the trackSale snippet + where to inject it, and the self-verify step. The agent follows this instead of guessing a contract.',
      inputSchema: {
        framework: z
          .enum(['next-app', 'next-pages', 'fastify', 'express', 'node', 'unknown'])
          .describe('The detected app framework. Determines where trackSale is injected.'),
        provider: z
          .enum(['stripe', 'polar', 'lemonsqueezy', 'paddle', 'unknown'])
          .default('stripe')
          .describe('The detected payment provider.'),
        mode: z
          .enum(['stripe_connect', 's2s'])
          .optional()
          .default('stripe_connect')
          .describe(
            "Payment-tracking mode. 'stripe_connect' (default) = Connect autocaptures the sale (metadata only, no trackSale); 's2s' = inject trackSale in your webhook.",
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
        "Fire the synthetic click->lead->sale verification chain through Affitor's REAL attribution pipeline (isolated is_test rows). This is the agent's PROOF step: run it, then poll affitor_readiness until integration_verified:true. Rate-limited to 10/program/hour — on a rate_limited result, wait retry_after_seconds, don't hammer.",
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
        'Report a sale. Creates a REAL sale and commission unless testMode is true. Resolves attribution by customerExternalId (bound at lead time).',
      inputSchema: {
        customerExternalId: z
          .string()
          .optional()
          .describe("Advertiser's own user id — resolves attribution (no clickId needed once bound at lead time). One of customerExternalId / clickId is required."),
        clickId: z.string().optional().describe('Affitor click id. One of clickId / customerExternalId is required.'),
        amount: z.number().int().positive().describe('Sale amount in integer cents (e.g. 4999 = $49.99).'),
        invoiceId: z.string().describe('Idempotency key — dedups retries (your invoice/transaction id).'),
        currency: z.string().optional().describe('ISO currency code (default USD).'),
        saleType: z.enum(['payment', 'subscription']).optional().describe('Whether this is a one-off payment or a subscription.'),
        isRecurring: z.boolean().optional().describe('Whether this sale recurs (subscription renewal).'),
        subscriptionId: z.string().optional().describe('Provider subscription id, if applicable.'),
        subscriptionInterval: z
          .enum(['monthly', 'quarterly', 'annual'])
          .optional()
          .describe('Billing interval for a subscription sale.'),
        testMode: z
          .boolean()
          .optional()
          .describe('Record a test sale (is_test, no commission) instead of a real one.'),
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
        'Report a refund (omit amount = full → commission reversed; partial → refunded). Idempotent by invoiceId. With testMode, returns what would be sent and calls nothing.',
      inputSchema: {
        invoiceId: z.string().describe('The sale\'s idempotency key (the `invoiceId` you passed to affitor_track_sale).'),
        refundAmountCents: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Refund amount in integer cents. Omit (or 0) = full refund → commission reversed; partial → refunded.'),
        refundReason: z.string().optional().describe('Optional human-readable refund reason.'),
        testMode: z
          .boolean()
          .optional()
          .describe('Dry run: return the refund that would be sent, without calling the API.'),
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
  const apiKey = process.env.AFFITOR_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      '@affitor/mcp: AFFITOR_API_KEY is required. Set it in your MCP client config, e.g.\n' +
        '  "env": { "AFFITOR_API_KEY": "your_program_key" }\n',
    );
    process.exit(1);
  }

  const apiUrl = process.env.AFFITOR_API_URL;
  const affitor = new Affitor({ apiKey, ...(apiUrl ? { apiUrl } : {}) });

  // Chain-firing isn't exposed by the SDK client (its `post` is private), so we
  // fire the endpoint via a small authenticated fetch — injected for testability.
  const runVerification: RunVerification = () =>
    fireVerificationChain(apiKey, apiUrl ?? 'https://api.affitor.com');

  // AFFITOR_MCP_WRITE=1 registers the tools that move money (track_sale, track_refund).

  const baseUrl = apiUrl ?? 'https://api.affitor.com';
  const server = new McpServer({ name: 'affitor', version: SERVER_VERSION });
  registerTools(server, affitor, runVerification, {
    allowWrites: process.env.AFFITOR_MCP_WRITE === '1',
    trackTestSale: (input) => postTestSale(apiKey, baseUrl, input),
  });

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
