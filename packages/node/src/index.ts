/**
 * @affitor/node — Affitor server-side SDK
 *
 * Typed, Bearer-authenticated client over the Affitor conversion API
 * (`/api/v1/track/{click,lead,sale}`). Use it from your backend to report
 * leads + sales for ANY payment provider (Stripe, Polar, Lemon Squeezy,
 * Paddle, …). Attribution model (Dub-style): bind the customer at lead time,
 * then a sale needs only `customerExternalId`.
 *
 *   const affitor = new Affitor({ apiKey: process.env.AFFITOR_API_KEY! });
 *   await affitor.trackLead({ customerExternalId: user.id, clickId });
 *   await affitor.trackSale({ customerExternalId: user.id, amount: 4999, invoiceId: inv.id });
 *
 * Server-side only — never ship the program API key to a browser.
 */

const DEFAULT_API_URL = 'https://api.affitor.com';

export interface AffitorOptions {
  /** Program API key (Bearer). Server-side only. */
  apiKey: string;
  /** API base override. Defaults to https://api.affitor.com */
  apiUrl?: string;
  /** Custom fetch (testing, or Node < 18 without global fetch). */
  fetch?: typeof fetch;
}

export interface TrackLeadInput {
  /** Advertiser's own user id — binds this customer to the click. */
  customerExternalId?: string;
  /** Affitor click id (from the `affitor_click_id` cookie). One of clickId / customerExternalId required. */
  clickId?: string;
  email?: string;
  eventName?: string;
  additionalData?: Record<string, unknown>;
}

export interface TrackSaleInput {
  /** Advertiser's own user id — resolves attribution (no clickId needed once bound at lead time). */
  customerExternalId?: string;
  clickId?: string;
  /** Sale amount in integer cents. */
  amount: number;
  /** ISO currency (default USD). */
  currency?: string;
  /** Idempotency key — dedups retries. */
  invoiceId: string;
  saleType?: 'payment' | 'subscription';
  isRecurring?: boolean;
  subscriptionId?: string;
  subscriptionInterval?: 'monthly' | 'quarterly' | 'annual';
  eventName?: string;
}

export interface TrackClickInput {
  affiliateUrl?: string;
  pageUrl?: string;
  referrerUrl?: string;
  existingClickId?: string;
}

export interface TrackRefundInput {
  /** The sale's idempotency key (the `invoiceId` you passed to trackSale). */
  invoiceId: string;
  /** Refund amount in integer cents. Omit (or 0) = full refund → commission reversed; partial → refunded. */
  refundAmountCents?: number;
  refundReason?: string;
}

export interface AffitorResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

/** Drop undefined values so the wire payload stays clean. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export class Affitor {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AffitorOptions) {
    if (!opts || !opts.apiKey) throw new Error('Affitor: `apiKey` is required');
    this.apiKey = opts.apiKey;
    this.apiUrl = (opts.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
    const f = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) throw new Error('Affitor: no global fetch — pass `options.fetch` (Node < 18)');
    this.fetchImpl = f;
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    auth: boolean,
  ): Promise<AffitorResponse<T>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${this.apiKey}`;

    try {
      const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(compact(body)),
      });
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        /* empty / non-JSON body */
      }
      return {
        ok: res.ok,
        status: res.status,
        data: res.ok ? (data as T) : null,
        error: res.ok ? undefined : ((data as { error?: string })?.error || res.statusText),
      };
    } catch (err) {
      return { ok: false, status: 0, data: null, error: (err as Error)?.message || 'network_error' };
    }
  }

  /**
   * Track a lead/signup. Binds `customerExternalId` ↔ `clickId` so later sales
   * resolve by `customerExternalId` alone.
   */
  trackLead(input: TrackLeadInput): Promise<AffitorResponse> {
    if (!input.customerExternalId && !input.clickId) {
      throw new Error('Affitor.trackLead: `customerExternalId` or `clickId` is required');
    }
    return this.post(
      '/api/v1/track/lead',
      {
        // canonical surface → live wire field
        customer_key: input.customerExternalId,
        click_id: input.clickId,
        email: input.email,
        event_name: input.eventName,
        additional_data: input.additionalData,
      },
      true,
    );
  }

  /** Track a sale. Resolves attribution by `customerExternalId` (then `clickId`). */
  trackSale(input: TrackSaleInput): Promise<AffitorResponse> {
    if (!input.customerExternalId && !input.clickId) {
      throw new Error('Affitor.trackSale: `customerExternalId` or `clickId` is required');
    }
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new Error('Affitor.trackSale: `amount` must be a positive integer (cents)');
    }
    if (!input.invoiceId) {
      throw new Error('Affitor.trackSale: `invoiceId` is required (idempotency key)');
    }
    return this.post(
      '/api/v1/track/sale',
      {
        customer_key: input.customerExternalId,
        click_id: input.clickId,
        amount_cents: input.amount,
        currency: input.currency,
        transaction_id: input.invoiceId,
        sale_type: input.saleType,
        is_recurring: input.isRecurring,
        subscription_id: input.subscriptionId,
        subscription_interval: input.subscriptionInterval,
        event_name: input.eventName,
      },
      true,
    );
  }

  /** Track a click (usually done in the browser via @affitor/sdk). Public endpoint, no auth. */
  trackClick(input: TrackClickInput = {}): Promise<AffitorResponse> {
    return this.post(
      '/api/v1/track/click',
      {
        affiliate_url: input.affiliateUrl,
        page_url: input.pageUrl,
        referrer_url: input.referrerUrl,
        existing_click_id: input.existingClickId,
      },
      false,
    );
  }

  /**
   * Reverse the commission for a sale on refund. Call from your provider's
   * refund webhook. Full refund (amount omitted) → commission `reversed`;
   * partial → `refunded` (proportional). Idempotent by `invoiceId`.
   */
  trackRefund(input: TrackRefundInput): Promise<AffitorResponse> {
    if (!input.invoiceId) {
      throw new Error('Affitor.trackRefund: `invoiceId` is required');
    }
    return this.post(
      '/api/v1/track/refund',
      {
        transaction_id: input.invoiceId,
        refund_amount_cents: input.refundAmountCents,
        refund_reason: input.refundReason,
      },
      true,
    );
  }
}

export default Affitor;
