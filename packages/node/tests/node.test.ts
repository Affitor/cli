import { describe, expect, it, vi } from 'vitest';
import { Affitor } from '../src/index';

function mockFetch(response: { ok?: boolean; status?: number; json?: unknown } = {}) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.json ?? {},
  });
}

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return new Affitor({ apiKey: 'aff_test', apiUrl: 'https://api.test', fetch: fetchImpl as unknown as typeof fetch });
}

describe('Affitor constructor', () => {
  it('throws without apiKey', () => {
    expect(() => new Affitor({} as never)).toThrow(/apiKey/);
  });
});

describe('trackLead', () => {
  it('POSTs to /api/v1/track/lead with Bearer + mapped body', async () => {
    const f = mockFetch();
    await client(f).trackLead({ customerExternalId: 'user_1', clickId: 'clk_1', email: 'a@b.com' });
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe('https://api.test/api/v1/track/lead');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer aff_test');
    expect(JSON.parse(opts.body)).toEqual({ customer_key: 'user_1', click_id: 'clk_1', email: 'a@b.com' });
  });

  it('throws when neither customerExternalId nor clickId', () => {
    expect(() => client(mockFetch()).trackLead({})).toThrow(/customerExternalId.*clickId|clickId/);
  });
});

describe('trackSale', () => {
  it('maps canonical → wire fields incl. subscription', async () => {
    const f = mockFetch({ json: { ok: true } });
    await client(f).trackSale({
      customerExternalId: 'user_1',
      amount: 4999,
      currency: 'USD',
      invoiceId: 'inv_1',
      saleType: 'subscription',
      isRecurring: true,
      subscriptionId: 'sub_1',
      subscriptionInterval: 'monthly',
    });
    expect(f.mock.calls[0][0]).toBe('https://api.test/api/v1/track/sale');
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({
      customer_key: 'user_1',
      amount_cents: 4999,
      currency: 'USD',
      transaction_id: 'inv_1',
      sale_type: 'subscription',
      is_recurring: true,
      subscription_id: 'sub_1',
      subscription_interval: 'monthly',
    });
  });

  it('throws on non-positive / non-integer amount', () => {
    expect(() => client(mockFetch()).trackSale({ customerExternalId: 'u', amount: 0, invoiceId: 'i' })).toThrow(/amount/);
    expect(() => client(mockFetch()).trackSale({ customerExternalId: 'u', amount: 9.9, invoiceId: 'i' })).toThrow(/amount/);
  });

  it('throws without invoiceId', () => {
    expect(() => client(mockFetch()).trackSale({ customerExternalId: 'u', amount: 100, invoiceId: '' })).toThrow(/invoiceId/);
  });

  it('drops undefined fields from the wire payload', async () => {
    const f = mockFetch();
    await client(f).trackSale({ customerExternalId: 'u', amount: 100, invoiceId: 'i' });
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body).toEqual({ customer_key: 'u', amount_cents: 100, transaction_id: 'i' });
  });
});

describe('trackClick', () => {
  it('POSTs to /track/click WITHOUT auth header', async () => {
    const f = mockFetch();
    await client(f).trackClick({ affiliateUrl: 'https://x.com?aff=p1' });
    expect(f.mock.calls[0][0]).toBe('https://api.test/api/v1/track/click');
    expect(f.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});

describe('error handling', () => {
  it('returns ok:false + error on non-2xx', async () => {
    const f = mockFetch({ ok: false, status: 409, json: { error: 'duplicate' } });
    const r = await client(f).trackSale({ customerExternalId: 'u', amount: 100, invoiceId: 'i' });
    expect(r).toMatchObject({ ok: false, status: 409, error: 'duplicate', data: null });
  });

  it('returns ok:false on network throw (does not reject)', async () => {
    const f = vi.fn().mockRejectedValue(new Error('boom'));
    const r = await client(f).trackLead({ clickId: 'c' });
    expect(r).toMatchObject({ ok: false, status: 0, error: 'boom' });
  });
});

describe('trackRefund', () => {
  it('POSTs to /api/v1/track/refund with Bearer + mapped body', async () => {
    const f = mockFetch();
    await client(f).trackRefund({ invoiceId: 'inv_1', refundAmountCents: 2500, refundReason: 'customer request' });
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe('https://api.test/api/v1/track/refund');
    expect(opts.headers.Authorization).toBe('Bearer aff_test');
    expect(JSON.parse(opts.body)).toEqual({
      transaction_id: 'inv_1',
      refund_amount_cents: 2500,
      refund_reason: 'customer request',
    });
  });

  it('full refund (amount omitted) → only transaction_id on the wire', async () => {
    const f = mockFetch();
    await client(f).trackRefund({ invoiceId: 'inv_2' });
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ transaction_id: 'inv_2' });
  });

  it('throws without invoiceId', () => {
    expect(() => client(mockFetch()).trackRefund({ invoiceId: '' })).toThrow(/invoiceId/);
  });
});
