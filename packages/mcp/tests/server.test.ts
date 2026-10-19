import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Affitor } from '@affitor/sdk/server';
import {
  registerTools,
  registerCouponTools,
  createCouponClient,
  postTestSale,
  type AffitorLike,
  type CouponClient,
  type CouponRequest,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, '../dist/index.js');

// Registered by default. The two money tools need AFFITOR_MCP_WRITE=1.
const DEFAULT_TOOLS = [
  'affitor_readiness',
  'affitor_track_lead',
  'affitor_track_click',
  'affitor_get_integration_plan',
  'affitor_run_verification',
] as const;
const WRITE_TOOLS = ['affitor_track_sale', 'affitor_track_refund'] as const;

// ── 1. Integration: spawn the BUILT server over stdio, drive with MCP Client ──
describe('@affitor/mcp stdio server (spawned, built dist)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath, // node
      args: [SERVER_ENTRY],
      env: { AFFITOR_API_KEY: 'test_key', AFFITOR_API_URL: 'http://127.0.0.1:1', AFFITOR_MCP_WRITE: '1' },
    });
    client = new Client({ name: 'test-client', version: '0.0.0' });
    // connect() performs the MCP `initialize` handshake.
    await client.connect(transport);
  }, 20000);

  afterAll(async () => {
    await client?.close();
  });

  it('initialize succeeds and reports server info', () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('affitor');
  });

  it('with AFFITOR_MCP_WRITE=1, tools/list returns all 7 tools, each annotated', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...DEFAULT_TOOLS, ...WRITE_TOOLS].sort());

    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe('boolean');
    }
    for (const name of WRITE_TOOLS) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    expect(tools.find((t) => t.name === 'affitor_readiness')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'affitor_get_integration_plan')!.annotations?.readOnlyHint).toBe(true);

    // Spot-check that affitor_track_sale exposes its key fields in the schema.
    const sale = tools.find((t) => t.name === 'affitor_track_sale')!;
    const props = sale.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['customerExternalId', 'clickId', 'amount', 'invoiceId', 'currency']),
    );
    expect((sale.inputSchema.required as string[]) ?? []).toContain('invoiceId');
  });
});

describe('@affitor/mcp stdio server without AFFITOR_MCP_WRITE', () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: { AFFITOR_API_KEY: 'test_key', AFFITOR_API_URL: 'http://127.0.0.1:1' },
    });
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);
  }, 20000);

  afterAll(async () => {
    await client?.close();
  });

  it('does not offer the money tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...DEFAULT_TOOLS].sort());
  });

  it('a call to affitor_track_sale is refused, not executed', async () => {
    const res = await client
      .callTool({ name: 'affitor_track_sale', arguments: { clickId: 'c', amount: 100, invoiceId: 'i' } })
      .catch((err: Error) => ({ isError: true, content: [{ type: 'text', text: err.message }] }));
    expect(res.isError).toBe(true);
  });
});

// ── 2. tools/call against a MOCKED fetch — asserts wire contract ──
describe('@affitor/mcp tools/call → wire contract (mocked fetch)', () => {
  it('affitor_track_sale hits /api/v1/track/sale with Bearer + snake_case body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mockFetch: typeof fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true, commission_id: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    // A REAL Affitor client wired to the mock fetch — exercises the true wire mapping.
    const affitor = new Affitor({
      apiKey: 'prog_secret',
      apiUrl: 'https://api.affitor.com',
      fetch: mockFetch,
    });

    // Register tools on an in-memory MCP server, call through a connected client.
    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerTools(server, affitor, undefined, { allowWrites: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: 'affitor_track_sale',
      arguments: {
        customerExternalId: 'u_42',
        amount: 4999,
        invoiceId: 'inv_abc',
        currency: 'USD',
        saleType: 'subscription',
        isRecurring: true,
        subscriptionInterval: 'monthly',
      },
    });

    expect(res.isError).toBeFalsy();

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe('https://api.affitor.com/api/v1/track/sale');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer prog_secret');

    const body = JSON.parse(String(init.body));
    // canonical SDK input → live snake_case wire fields
    expect(body).toMatchObject({
      customer_key: 'u_42',
      amount_cents: 4999,
      currency: 'USD',
      transaction_id: 'inv_abc',
      sale_type: 'subscription',
      is_recurring: true,
      subscription_interval: 'monthly',
    });
    // compact() must have dropped undefined fields.
    expect('click_id' in body).toBe(false);

    // The text content echoes the API payload.
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toMatchObject({ ok: true, status: 200 });

    await client.close();
  });

  it('returns isError when the API resolves { ok: false }', async () => {
    const mockFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_api_key' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const affitor = new Affitor({ apiKey: 'bad', apiUrl: 'https://api.affitor.com', fetch: mockFetch });

    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerTools(server, affitor);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const res = await client.callTool({
      name: 'affitor_track_lead',
      arguments: { customerExternalId: 'u_1' },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toBe('invalid_api_key');

    await client.close();
  });
});

// ── 3. Unit: handlers via stubbed Affitor client (no network at all) ──
describe('@affitor/mcp tool handlers (stubbed client)', () => {
  it('affitor_track_sale forwards parsed args to client.trackSale', async () => {
    const seen: unknown[] = [];
    const stub: AffitorLike = {
      readiness: async () => ({}) as never,
      trackLead: async () => ({ ok: true, status: 200, data: null }),
      trackSale: async (input) => {
        seen.push(input);
        return { ok: true, status: 200, data: { commission_id: 7 } };
      },
      trackRefund: async () => ({ ok: true, status: 200, data: null }),
      trackClick: async () => ({ ok: true, status: 200, data: null }),
    };

    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerTools(server, stub, undefined, { allowWrites: true });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const res = await client.callTool({
      name: 'affitor_track_sale',
      arguments: { clickId: 'clk_1', amount: 1000, invoiceId: 'inv_x' },
    });
    expect(res.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ clickId: 'clk_1', amount: 1000, invoiceId: 'inv_x' });

    await client.close();
  });

  it('affitor_get_integration_plan returns a pure plan (no client call)', async () => {
    const stub: AffitorLike = {
      readiness: async () => {
        throw new Error('readiness should not be called');
      },
      trackLead: async () => {
        throw new Error('trackLead should not be called');
      },
      trackSale: async () => {
        throw new Error('trackSale should not be called');
      },
      trackRefund: async () => {
        throw new Error('trackRefund should not be called');
      },
      trackClick: async () => {
        throw new Error('trackClick should not be called');
      },
    };

    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerTools(server, stub);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const res = await client.callTool({
      name: 'affitor_get_integration_plan',
      arguments: { framework: 'fastify', provider: 'stripe', mode: 's2s' },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0].text;
    const plan = JSON.parse(text) as {
      steps: string[];
      recipe: { sale_path: string; sale: { inject_target: string } | null };
    };
    expect(plan.recipe.sale_path).toBe('webhook_sdk');
    expect(plan.recipe.sale?.inject_target).toContain("fastify.post('/webhooks/stripe'");
    expect(plan.steps).toHaveLength(6);

    await client.close();
  });

  it('affitor_run_verification returns the injected runVerification payload (no network)', async () => {
    const stub: AffitorLike = {
      readiness: async () => ({}) as never,
      trackLead: async () => ({ ok: true, status: 200, data: null }),
      trackSale: async () => ({ ok: true, status: 200, data: null }),
      trackRefund: async () => ({ ok: true, status: 200, data: null }),
      trackClick: async () => ({ ok: true, status: 200, data: null }),
    };
    const payload = {
      data: {
        type: 'chain',
        verdict: { click: 'attributed', lead: 'attributed', sale: 'attributed' },
        attributed: true,
      },
    };

    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerTools(server, stub, async () => payload);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const res = await client.callTool({ name: 'affitor_run_verification', arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toEqual(payload);

    await client.close();
  });

  it('affitor_run_verification degrades to a not-configured failure when runVerification is absent', async () => {
    const stub: AffitorLike = {
      readiness: async () => ({}) as never,
      trackLead: async () => ({ ok: true, status: 200, data: null }),
      trackSale: async () => ({ ok: true, status: 200, data: null }),
      trackRefund: async () => ({ ok: true, status: 200, data: null }),
      trackClick: async () => ({ ok: true, status: 200, data: null }),
    };

    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerTools(server, stub);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const res = await client.callTool({ name: 'affitor_run_verification', arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toBe('affitor_run_verification is not configured in this MCP build');

    await client.close();
  });

  it('affitor_track_lead rejects when neither customerExternalId nor clickId is given', async () => {
    const stub: AffitorLike = {
      readiness: async () => ({}) as never,
      trackLead: async () => {
        throw new Error('should not be called');
      },
      trackSale: async () => ({ ok: true, status: 200, data: null }),
      trackRefund: async () => ({ ok: true, status: 200, data: null }),
      trackClick: async () => ({ ok: true, status: 200, data: null }),
    };

    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerTools(server, stub);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const res = await client.callTool({ name: 'affitor_track_lead', arguments: { email: 'a@b.com' } });
    expect(res.isError).toBe(true);

    await client.close();
  });
});

// ── 4. Test mode and dry run ──
describe('@affitor/mcp test mode', () => {
  const noCalls: AffitorLike = {
    readiness: async () => ({}) as never,
    trackLead: async () => ({ ok: true, status: 200, data: null }),
    trackSale: async () => {
      throw new Error('a test sale must not call the real trackSale');
    },
    trackRefund: async () => {
      throw new Error('a dry-run refund must not call the API');
    },
    trackClick: async () => ({ ok: true, status: 200, data: null }),
  };

  async function connect(affitor: AffitorLike, trackTestSale?: (input: unknown) => Promise<unknown>) {
    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerTools(server, affitor, undefined, { allowWrites: true, trackTestSale: trackTestSale as never });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  it('affitor_track_sale with testMode goes to the test-sale path, never the real one', async () => {
    const seen: unknown[] = [];
    const client = await connect(noCalls, async (input) => {
      seen.push(input);
      return { ok: true, status: 200, data: { test_mode: true } };
    });
    const res = await client.callTool({
      name: 'affitor_track_sale',
      arguments: { clickId: 'clk_1', amount: 1000, invoiceId: 'inv_t', testMode: true },
    });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([expect.objectContaining({ clickId: 'clk_1', amount: 1000, invoiceId: 'inv_t' })]);
    await client.close();
  });

  it('affitor_track_refund with testMode is a dry run', async () => {
    const client = await connect(noCalls);
    const res = await client.callTool({
      name: 'affitor_track_refund',
      arguments: { invoiceId: 'inv_t', refundAmountCents: 500, testMode: true },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toEqual({ dry_run: true, would_send: { invoiceId: 'inv_t', refundAmountCents: 500 } });
    await client.close();
  });

  it('affitor_track_lead with testMode sends test_mode', async () => {
    const seen: unknown[] = [];
    const client = await connect({
      ...noCalls,
      trackLead: async (input) => {
        seen.push(input);
        return { ok: true, status: 200, data: null };
      },
    });
    await client.callTool({ name: 'affitor_track_lead', arguments: { clickId: 'clk_1', testMode: true } });
    expect(seen[0]).toMatchObject({ clickId: 'clk_1', additionalData: { test_mode: true } });
    await client.close();
  });

  it('postTestSale posts the snake_case body with additional_data.test_mode and no undefined fields', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ success: true, data: { test_mode: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const out = await postTestSale('prog_secret', 'https://api.affitor.com', { clickId: 'clk_1', amount: 1000, invoiceId: 'inv_t' });
      expect(out).toMatchObject({ ok: true, status: 200 });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.affitor.com/api/v1/track/sale');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer prog_secret');
    const body = JSON.parse(String(calls[0].init.body));
    // test_ prefix: a test sale must never take the transaction id a real sale will use.
    expect(body).toEqual({ click_id: 'clk_1', amount_cents: 1000, transaction_id: 'test_inv_t', additional_data: { test_mode: true } });
  });

  it('postTestSale turns an API error into { ok: false, error }', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Invalid API token' }), { status: 401 })) as unknown as typeof fetch;
    try {
      const out = await postTestSale('bad', 'https://api.affitor.com', { clickId: 'c', amount: 1, invoiceId: 'i' });
      expect(out).toMatchObject({ ok: false, status: 401, error: 'Invalid API token' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('@affitor/mcp idempotency keys', () => {
  it.each([
    ['affitor_track_sale', { clickId: 'c', amount: 100, invoiceId: '' }],
    ['affitor_track_sale', { clickId: 'c', amount: 100, invoiceId: '', testMode: true }],
    ['affitor_track_refund', { invoiceId: '' }],
    ['affitor_track_refund', { invoiceId: '', testMode: true }],
  ])('%s refuses an empty invoiceId before any call (%j)', async (name, args) => {
    const calls = { trackSale: 0, trackRefund: 0, trackTestSale: 0 };
    const stub: AffitorLike = {
      readiness: async () => ({}) as never,
      trackLead: async () => ({ ok: true, status: 200, data: null }),
      trackSale: async () => {
        calls.trackSale++;
        return { ok: true, status: 200, data: null };
      },
      trackRefund: async () => {
        calls.trackRefund++;
        return { ok: true, status: 200, data: null };
      },
      trackClick: async () => ({ ok: true, status: 200, data: null }),
    };
    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerTools(server, stub, undefined, {
      allowWrites: true,
      trackTestSale: async () => {
        calls.trackTestSale++;
        return { ok: true, status: 200, data: null };
      },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = await client
      .callTool({ name, arguments: args })
      .catch((err: Error) => ({ isError: true, content: [{ type: 'text', text: err.message }] }));
    expect(res.isError).toBe(true);
    expect(calls).toEqual({ trackSale: 0, trackRefund: 0, trackTestSale: 0 });
    await client.close();
  });
});

// ── 5. Coupon tools: separate key, separate flag, strict inputs ──
const COUPON_TOOLS = ['affitor_create_coupon', 'affitor_lock_coupon', 'affitor_get_coupon'] as const;
const sorted = (names: readonly string[]) => [...names].sort();

async function spawnedTools(env: Record<string, string>): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { AFFITOR_API_URL: 'http://127.0.0.1:1', ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

function spawnedExit(env: Record<string, string>) {
  return spawnSync(process.execPath, [SERVER_ENTRY], { env, input: '', encoding: 'utf8', timeout: 10000 });
}

describe('@affitor/mcp tool families by configuration (spawned, built dist)', () => {
  it.each([
    ['program key only, WRITE off', { AFFITOR_API_KEY: 'prog_k' }, DEFAULT_TOOLS],
    ['program key only, WRITE on (COUPONS=1 without agent key)', { AFFITOR_API_KEY: 'prog_k', AFFITOR_MCP_WRITE: '1', AFFITOR_MCP_COUPONS: '1' }, [...DEFAULT_TOOLS, ...WRITE_TOOLS]],
    ['agent key only, COUPONS=1', { AFFITOR_AGENT_KEY: 'agt_k', AFFITOR_MCP_COUPONS: '1' }, COUPON_TOOLS],
    ['agent key only, COUPONS=1, WRITE=1 (no program client)', { AFFITOR_AGENT_KEY: 'agt_k', AFFITOR_MCP_COUPONS: '1', AFFITOR_MCP_WRITE: '1' }, COUPON_TOOLS],
    ['both keys, COUPONS=1, WRITE off', { AFFITOR_API_KEY: 'prog_k', AFFITOR_AGENT_KEY: 'agt_k', AFFITOR_MCP_COUPONS: '1' }, [...DEFAULT_TOOLS, ...COUPON_TOOLS]],
    ['both keys, both flags on', { AFFITOR_API_KEY: 'prog_k', AFFITOR_AGENT_KEY: 'agt_k', AFFITOR_MCP_COUPONS: '1', AFFITOR_MCP_WRITE: '1' }, [...DEFAULT_TOOLS, ...WRITE_TOOLS, ...COUPON_TOOLS]],
    ['both keys, COUPONS off', { AFFITOR_API_KEY: 'prog_k', AFFITOR_AGENT_KEY: 'agt_k' }, DEFAULT_TOOLS],
    ['missing coupon key, program key present, COUPONS=1', { AFFITOR_API_KEY: 'prog_k', AFFITOR_MCP_COUPONS: '1' }, DEFAULT_TOOLS],
  ] as const)('%s', async (_label, env, expected) => {
    expect(await spawnedTools(env)).toEqual(sorted(expected));
  }, 20000);

  it.each([
    ['agent key only, COUPONS off', { AFFITOR_AGENT_KEY: 'agt_secret_value' }],
    ['agent key only, COUPONS off, WRITE=1', { AFFITOR_AGENT_KEY: 'agt_secret_value', AFFITOR_MCP_WRITE: '1' }],
    ['missing coupon key, no program key, COUPONS=1', { AFFITOR_MCP_COUPONS: '1' }],
    ['nothing set', {}],
  ] as const)('%s: no tools, exits with a setup hint naming both keys', (_label, env) => {
    const out = spawnedExit(env);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('AFFITOR_API_KEY');
    expect(out.stderr).toContain('AFFITOR_AGENT_KEY');
    expect(out.stderr).not.toContain('agt_secret_value');
  });

  it('coupon tools carry the required annotations and short descriptions', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: { AFFITOR_AGENT_KEY: 'agt_k', AFFITOR_MCP_COUPONS: '1', AFFITOR_API_URL: 'http://127.0.0.1:1' },
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ['affitor_create_coupon', 'affitor_lock_coupon']) {
      expect(byName[name].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
      expect(byName[name].description).toContain('same idempotency_key and the same payload');
      expect(byName[name].description).toContain('409');
      expect(byName[name].description).toMatch(/never try a new key/);
    }
    expect(byName.affitor_get_coupon.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    for (const name of COUPON_TOOLS) {
      const tool = byName[name];
      expect(tool.description!.length, `${name} description length`).toBeLessThanOrEqual(400);
      expect(tool.description).not.toContain('—');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      const props = tool.inputSchema.properties as Record<string, { description?: string }>;
      for (const [key, prop] of Object.entries(props)) expect(prop.description, `${name}.${key} description`).toBeTruthy();
      for (const banned of ['program_id', 'account_id', 'api_key', 'agent_key', 'actor', 'permission', 'scope']) {
        expect(Object.keys(props)).not.toContain(banned);
      }
    }
    expect(byName.affitor_create_coupon.inputSchema.required).toEqual(
      expect.arrayContaining(['partner_program_id', 'referral_link_id', 'product_id', 'discount', 'idempotency_key']),
    );
  }, 20000);
});

describe('@affitor/mcp coupon tools → wire contract (mocked fetch)', () => {
  const CREATE_ARGS = {
    partner_program_id: 31,
    referral_link_id: 82,
    product_id: 'replay',
    discount: { kind: 'percent', percent_off_bps: 1000, duration: 'once' },
    prefix: 'BTO',
    max_redemptions: 20,
    expires_at: '2026-11-30T00:00:00Z',
    idempotency_key: 'cpn_link82_v1',
  };
  const activeBody = { data: { coupon_id: 501, program_id: 1115, status: 'active', version: 1, code: 'BTO10ABC', tracking_ready: true } };

  async function withFetch(
    respond: (url: string, init: RequestInit) => Response,
    run: (client: Client) => Promise<void>,
  ): Promise<{ url: string; init: RequestInit }[]> {
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return respond(String(url), init);
    }) as unknown as typeof fetch;
    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerCouponTools(server, createCouponClient('agt_secret', 'https://api.affitor.com'));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      await run(client);
    } finally {
      globalThis.fetch = realFetch;
      await client.close();
    }
    return calls;
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const text = (res: unknown) => (res as { content: { text: string }[] }).content[0].text;
  const call = (client: Client, name: string, args: Record<string, unknown>) =>
    client
      .callTool({ name, arguments: args })
      .catch((err: Error) => ({ isError: true, content: [{ type: 'text', text: err.message }] }));

  it('create sends Idempotency-Key from idempotency_key, the agent key only, and a body without idempotency_key', async () => {
    let res: unknown;
    const calls = await withFetch(() => json(201, activeBody), async (client) => {
      res = await call(client, 'affitor_create_coupon', CREATE_ARGS);
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(JSON.parse(text(res))).toEqual(activeBody);
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe('https://api.affitor.com/api/v1/coupons');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer agt_secret');
    expect(headers['Idempotency-Key']).toBe('cpn_link82_v1');
    const { idempotency_key: _omit, ...expectedBody } = CREATE_ARGS;
    expect(JSON.parse(String(init.body))).toEqual(expectedBody);
  });

  it('lock posts expected_version only, with the Idempotency-Key header', async () => {
    const calls = await withFetch(() => json(200, { data: { ...activeBody.data, status: 'locked', version: 2 } }), async (client) => {
      const res = await call(client, 'affitor_lock_coupon', { coupon_id: 501, expected_version: 1, idempotency_key: 'lock_501_v1' });
      expect(res.isError).toBeFalsy();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.affitor.com/api/v1/coupons/501/lock');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['Idempotency-Key']).toBe('lock_501_v1');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer agt_secret');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ expected_version: 1 });
  });

  it('get sends GET with no body and no Idempotency-Key', async () => {
    const calls = await withFetch(() => json(200, activeBody), async (client) => {
      const res = await call(client, 'affitor_get_coupon', { coupon_id: 501 });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(text(res))).toEqual(activeBody);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.affitor.com/api/v1/coupons/501');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
    expect('Idempotency-Key' in (calls[0].init.headers as Record<string, string>)).toBe(false);
  });

  it('a 202 pending body is a non-error pending result, never an active code', async () => {
    const pendingBody = { data: { coupon_id: 501, program_id: 1115, status: 'pending', version: 1, code: null, tracking_ready: false, reason: 'provider_confirmation_pending', status_url: '/api/v1/coupons/501' } };
    await withFetch(() => json(202, pendingBody), async (client) => {
      const res = await call(client, 'affitor_create_coupon', CREATE_ARGS);
      expect(res.isError).toBeFalsy();
      const out = JSON.parse(text(res));
      expect(out).toMatchObject({ pending: true, http_status: 202, data: pendingBody.data });
      expect(out.next_action).toContain('affitor_get_coupon');
      expect(out.next_action).toContain('Not an active code');
    });
  });

  it('a 200 get with status held is marked pending, not an error', async () => {
    await withFetch(() => json(200, { data: { coupon_id: 501, status: 'held', code: null } }), async (client) => {
      const res = await call(client, 'affitor_get_coupon', { coupon_id: 501 });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(text(res))).toMatchObject({ pending: true, http_status: 200 });
    });
  });

  it.each([
    [409, 'idempotency_conflict', true],
    [403, 'insufficient_scope', false],
    [404, 'not_found', false],
    [401, 'unauthorized', false],
  ])('HTTP %i returns isError with only the status and error.code', async (status, code, hint) => {
    await withFetch(
      () => json(status, { error: { code, message: 'raw provider text sk_live_leak', details: { args: CREATE_ARGS } } }),
      async (client) => {
        const res = await call(client, 'affitor_create_coupon', CREATE_ARGS);
        expect(res.isError).toBe(true);
        const out = JSON.parse(text(res));
        expect(out.http_status).toBe(status);
        expect(out.error_code).toBe(code);
        expect(Object.keys(out).sort()).toEqual(hint ? ['error_code', 'hint', 'http_status'] : ['error_code', 'http_status']);
        if (hint) expect(out.hint).toContain('same idempotency_key and the same payload');
        const raw = text(res);
        for (const leak of ['sk_live_leak', 'raw provider text', 'agt_secret', 'cpn_link82_v1', 'replay']) expect(raw).not.toContain(leak);
      },
    );
  });

  it('a 429 keeps retry info from Retry-After', async () => {
    await withFetch(() => json(429, { error: { code: 'rate_limited' } }, { 'Retry-After': '30' }), async (client) => {
      const res = await call(client, 'affitor_get_coupon', { coupon_id: 501 });
      expect(res.isError).toBe(true);
      expect(JSON.parse(text(res))).toEqual({ http_status: 429, error_code: 'rate_limited', retry_after_seconds: 30 });
    });
  });

  it.each([
    ['an extra program_id', { ...CREATE_ARGS, program_id: 1115 }],
    ['an extra api_key', { ...CREATE_ARGS, api_key: 'x' }],
    ['a mixed discount variant', { ...CREATE_ARGS, discount: { kind: 'percent', percent_off_bps: 1000, amount_off_minor: 500, duration: 'once' } }],
    ['a fixed discount in eur', { ...CREATE_ARGS, discount: { kind: 'fixed', amount_off_minor: 500, currency: 'eur', duration: 'once' } }],
    ['a float percent', { ...CREATE_ARGS, discount: { kind: 'percent', percent_off_bps: 10.5, duration: 'once' } }],
    ['a forever duration', { ...CREATE_ARGS, discount: { kind: 'percent', percent_off_bps: 1000, duration: 'forever' } }],
    ['an 11-digit id', { ...CREATE_ARGS, referral_link_id: 12345678901 }],
    ['a short idempotency_key', { ...CREATE_ARGS, idempotency_key: 'short' }],
    ['a 13-char prefix', { ...CREATE_ARGS, prefix: 'ABCDEFGHIJKLM' }],
    ['no idempotency_key', (({ idempotency_key: _k, ...rest }) => rest)(CREATE_ARGS)],
  ])('create rejects %s before any call', async (_label, args) => {
    const calls = await withFetch(() => json(201, activeBody), async (client) => {
      const res = await call(client, 'affitor_create_coupon', args as Record<string, unknown>);
      expect(res.isError).toBe(true);
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['affitor_lock_coupon', { coupon_id: 501, expected_version: 1, idempotency_key: 'lock_501_v1', program_id: 1 }],
    ['affitor_lock_coupon', { coupon_id: 501, expected_version: 0, idempotency_key: 'lock_501_v1' }],
    ['affitor_get_coupon', { coupon_id: 501, program_id: 1 }],
    ['affitor_get_coupon', { coupon_id: 0 }],
  ])('%s rejects %j before any call', async (name, args) => {
    const calls = await withFetch(() => json(200, activeBody), async (client) => {
      const res = await call(client, name, args);
      expect(res.isError).toBe(true);
    });
    expect(calls).toHaveLength(0);
  });

  it('registerCouponTools uses only the injected client and registers exactly the coupon tools', async () => {
    const seen: CouponRequest[] = [];
    const stub: CouponClient = async (request) => {
      seen.push(request);
      return { status: 200, body: activeBody };
    };
    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerCouponTools(server, stub);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(sorted(COUPON_TOOLS));
    await client.callTool({ name: 'affitor_lock_coupon', arguments: { coupon_id: 7, expected_version: 3, idempotency_key: 'lock_7_v3_ab' } });
    expect(seen).toEqual([{ method: 'POST', path: '/api/v1/coupons/7/lock', body: { expected_version: 3 }, idempotencyKey: 'lock_7_v3_ab' }]);
    await client.close();
  });
});

describe('@affitor/mcp public surface and registry metadata', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
  const serverJson = JSON.parse(readFileSync(resolve(__dirname, '../server.json'), 'utf8'));
  const npmEntry = serverJson.packages.find((p: { registryType: string }) => p.registryType === 'npm');
  const env = Object.fromEntries(npmEntry.environmentVariables.map((v: { name: string }) => [v.name, v]));

  it('registerTools keeps its (server, affitor, runVerification?, options?) shape and registers no coupon tools', async () => {
    expect(registerTools.length).toBe(3);
    const stub: AffitorLike = {
      readiness: async () => ({}) as never,
      trackLead: async () => ({ ok: true, status: 200, data: null }),
      trackSale: async () => ({ ok: true, status: 200, data: null }),
      trackRefund: async () => ({ ok: true, status: 200, data: null }),
      trackClick: async () => ({ ok: true, status: 200, data: null }),
    };
    const server = new McpServer({ name: 'affitor', version: '0.1.0' });
    registerTools(server, stub, undefined, { allowWrites: true });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(sorted([...DEFAULT_TOOLS, ...WRITE_TOOLS]));
    await client.close();
  });

  it('server.json npm version equals package.json version, and server.json ships in the package', () => {
    expect(npmEntry.identifier).toBe(pkg.name);
    expect(npmEntry.version).toBe(pkg.version);
    expect(pkg.files).toContain('server.json');
  });

  it('server.json lists the env vars with the right required/secret flags', () => {
    expect(env.AFFITOR_API_KEY).toMatchObject({ isRequired: false, isSecret: true });
    expect(env.AFFITOR_AGENT_KEY).toMatchObject({ isRequired: false, isSecret: true });
    expect(env.AFFITOR_AGENT_KEY.description).toBeTruthy();
    expect(env.AFFITOR_MCP_COUPONS).toMatchObject({ isRequired: false });
    expect(env.AFFITOR_MCP_COUPONS.description).toMatch(/1/);
    expect(env.AFFITOR_MCP_COUPONS.description).toMatch(/[Oo]ff by default/);
    expect(env.AFFITOR_MCP_WRITE).toMatchObject({ isRequired: false });
    expect(env.AFFITOR_API_URL).toMatchObject({ isRequired: false });
  });
});
