import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Affitor } from '@affitor/sdk/server';
import { registerTools, type AffitorLike } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, '../dist/index.js');

const EXPECTED_TOOLS = [
  'affitor_readiness',
  'affitor_track_lead',
  'affitor_track_sale',
  'affitor_track_refund',
  'affitor_track_click',
  'affitor_get_integration_plan',
] as const;

// ── 1. Integration: spawn the BUILT server over stdio, drive with MCP Client ──
describe('@affitor/mcp stdio server (spawned, built dist)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath, // node
      args: [SERVER_ENTRY],
      env: { AFFITOR_API_KEY: 'test_key', AFFITOR_API_URL: 'http://127.0.0.1:1' },
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

  it('tools/list returns the 6 tools with input schemas', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());

    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }

    // Spot-check that affitor_track_sale exposes its key fields in the schema.
    const sale = tools.find((t) => t.name === 'affitor_track_sale')!;
    const props = sale.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['customerExternalId', 'clickId', 'amount', 'invoiceId', 'currency']),
    );
    expect((sale.inputSchema.required as string[]) ?? []).toContain('invoiceId');
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
    registerTools(server, affitor);
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
    registerTools(server, stub);
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
    expect(plan.steps).toHaveLength(5);

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
