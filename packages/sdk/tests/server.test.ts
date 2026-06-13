import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Affitor, AffitorApiError } from '../src/server';

const KEY = 'prog_secret_key';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

describe('Affitor server client', () => {
  it('defaults to the production api base', () => {
    const a = new Affitor(KEY);
    expect(a).toBeInstanceOf(Affitor);
  });

  it('throws when constructed without an api key', () => {
    expect(() => new Affitor('')).toThrow(/api key/i);
  });

  it('trackSale POSTs to /api/v1/track/sale with the Bearer header and body', async () => {
    fetchMock.mockResolvedValue(okJson({ success: true, sale_id: 7, commission_id: 9 }));

    const a = new Affitor(KEY, { apiBase: 'https://api.test' });
    const res = await a.trackSale({
      transaction_id: 'txn_1',
      click_id: 'clk_1',
      amount_cents: 4900,
      currency: 'USD',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/api/v1/track/sale');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      transaction_id: 'txn_1',
      click_id: 'clk_1',
      amount_cents: 4900,
      currency: 'USD',
    });

    expect(res).toEqual({ success: true, sale_id: 7, commission_id: 9 });
  });

  it('trackLead POSTs to /api/v1/track/lead with the Bearer header and body', async () => {
    fetchMock.mockResolvedValue(okJson({ success: true, message: 'Lead tracked successfully' }));

    const a = new Affitor(KEY, { apiBase: 'https://api.test' });
    await a.trackLead({ customer_key: 'cust_9', click_id: 'clk_1', email: 'x@y.com' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/api/v1/track/lead');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe(`Bearer ${KEY}`);

    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ customer_key: 'cust_9', click_id: 'clk_1', email: 'x@y.com' });
  });

  it('trackRefund POSTs to /api/v1/track/refund', async () => {
    fetchMock.mockResolvedValue(okJson({ success: true, status: 'reversed', commission_id: 3 }));

    const a = new Affitor(KEY, { apiBase: 'https://api.test' });
    const res = await a.trackRefund({ transaction_id: 'txn_1', refund_reason: 'customer request' });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/api/v1/track/refund');
    expect(JSON.parse(opts.body)).toMatchObject({ transaction_id: 'txn_1', refund_reason: 'customer request' });
    expect(res.success).toBe(true);
  });

  it('readiness GETs /api/v1/programs/me/readiness (no body, Bearer header)', async () => {
    fetchMock.mockResolvedValue(
      okJson({ program_id: 1, state: 'ready', integration_verified: false, blocker: 'live' }),
    );

    const a = new Affitor(KEY, { apiBase: 'https://api.test' });
    const res = await a.readiness();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/api/v1/programs/me/readiness');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(opts.body).toBeUndefined();
    expect(res.state).toBe('ready');
  });

  it('readiness?force_recheck=true appends the query param', async () => {
    fetchMock.mockResolvedValue(okJson({ program_id: 1, state: 'ready' }));
    const a = new Affitor(KEY, { apiBase: 'https://api.test' });
    await a.readiness({ forceRecheck: true });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/api/v1/programs/me/readiness?force_recheck=true');
  });

  it('throws AffitorApiError on a string-error envelope (tracking endpoints)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'Invalid API token' }),
    });

    const a = new Affitor(KEY, { apiBase: 'https://api.test' });
    await expect(a.trackSale({ transaction_id: 't', amount_cents: 1 })).rejects.toMatchObject({
      name: 'AffitorApiError',
      status: 401,
      message: 'Invalid API token',
    });
  });

  it('throws AffitorApiError on the typed envelope (readiness endpoint)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () =>
        JSON.stringify({ error: { code: 'rate_limited', message: 'Slow down', retry_after_seconds: 30 } }),
    });

    const a = new Affitor(KEY, { apiBase: 'https://api.test' });
    const err = await a.readiness().catch((e) => e);
    expect(err).toBeInstanceOf(AffitorApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(err.message).toBe('Slow down');
    expect(err.retryAfterSeconds).toBe(30);
  });
});
