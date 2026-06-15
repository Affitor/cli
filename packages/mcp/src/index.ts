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
 * Register the 6 Affitor tools on an MCP server. Exported for unit testing the
 * handlers with a stubbed `Affitor` client.
 *
 * Five tools wrap the `Affitor` client (readiness + track*). The sixth,
 * `affitor_get_integration_plan`, is PURE — it reads the canonical recipe
 * registry (`@affitor/recipes`) and never touches the client or the network.
 */
export function registerTools(server: McpServer, affitor: AffitorLike): void {
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
      },
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
        }),
      );
    },
  );

  server.registerTool(
    'affitor_track_sale',
    {
      description:
        'Report a sale. Resolves attribution by customerExternalId (bound at lead time).',
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
      },
    },
    async (args) => {
      if (!args.customerExternalId && !args.clickId) {
        return fail('affitor_track_sale: `customerExternalId` or `clickId` is required');
      }
      return runCall(() =>
        affitor.trackSale({
          customerExternalId: args.customerExternalId,
          clickId: args.clickId,
          amount: args.amount,
          invoiceId: args.invoiceId,
          currency: args.currency,
          saleType: args.saleType,
          isRecurring: args.isRecurring,
          subscriptionId: args.subscriptionId,
          subscriptionInterval: args.subscriptionInterval,
        }),
      );
    },
  );

  server.registerTool(
    'affitor_track_refund',
    {
      description:
        'Report a refund (omit amount = full → commission reversed; partial → refunded). Idempotent by invoiceId.',
      inputSchema: {
        invoiceId: z.string().describe('The sale\'s idempotency key (the `invoiceId` you passed to affitor_track_sale).'),
        refundAmountCents: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Refund amount in integer cents. Omit (or 0) = full refund → commission reversed; partial → refunded.'),
        refundReason: z.string().optional().describe('Optional human-readable refund reason.'),
      },
    },
    async (args) =>
      runCall(() =>
        affitor.trackRefund({
          invoiceId: args.invoiceId,
          refundAmountCents: args.refundAmountCents,
          refundReason: args.refundReason,
        }),
      ),
  );

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

  const server = new McpServer({ name: 'affitor', version: SERVER_VERSION });
  registerTools(server, affitor);

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
