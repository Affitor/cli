/**
 * affitor-sdk/server — Node fetch client for the Affitor v1 tracking API.
 *
 * Server-side counterpart to the browser SDK. Authenticates with a program
 * api_token (Bearer) and calls the real v1 endpoints:
 *   - POST /api/v1/track/lead          (trackLead)
 *   - POST /api/v1/track/sale          (trackSale)
 *   - POST /api/v1/track/refund        (trackRefund)
 *   - GET  /api/v1/programs/me/readiness (readiness)
 *
 * Uses the global `fetch` (Node 18+). No `window`/DOM access.
 *
 * Usage:
 *   import { Affitor } from 'affitor-sdk/server';
 *   const affitor = new Affitor(process.env.AFFITOR_API_KEY!);
 *   await affitor.trackSale({ transaction_id: 'txn_1', click_id: 'clk_1', amount_cents: 4900 });
 */

const DEFAULT_API_BASE = 'https://api.affitor.com';

export interface AffitorServerOptions {
  /** Override the tracking API base. Defaults to https://api.affitor.com. */
  apiBase?: string;
}

// ── Request param types (grounded in v1-tracking.ts) ────────────────────────

/** POST /api/v1/track/lead body (v1-tracking.ts:404, 619). */
export interface TrackLeadParams {
  /** Advertiser's unique customer identifier. One of customer_key / click_id required. */
  customer_key?: string;
  /** Affitor click id (from the browser cookie). */
  click_id?: string;
  /** Customer email (hashed server-side). */
  email?: string;
  /** Full click-id history this browser accumulated (shadow-lane candidates). */
  click_ids?: string[];
  session_id?: string;
  page_url?: string;
  /** Free-form passthrough (e.g. `{ event_name, test_mode, program_id }`). */
  additional_data?: Record<string, unknown>;
}

/** POST /api/v1/track/sale body (v1-tracking.ts:688-701). */
export interface TrackSaleParams {
  /** Unique processor transaction id (dedup key). Required. */
  transaction_id: string;
  /** Sale amount in the smallest currency unit (cents). Required, > 0. */
  amount_cents: number;
  /** Resolve the customer by key and/or click id. */
  customer_key?: string;
  click_id?: string;
  /** ISO 4217 currency code. Defaults server-side to 'USD'. */
  currency?: string;
  /** 'payment' | 'subscription'. Defaults server-side to 'payment'. */
  sale_type?: 'payment' | 'subscription';
  line_items?: unknown;
  is_recurring?: boolean;
  subscription_id?: string;
  subscription_interval?: 'monthly' | 'quarterly' | 'annual';
  product_id?: string;
  additional_data?: Record<string, unknown>;
}

/** POST /api/v1/track/refund body (v1-tracking.ts:1143). */
export interface TrackRefundParams {
  /** transaction_id of the original sale. Required. */
  transaction_id: string;
  /** Refund amount in cents. Omit (or 0) for a full refund. */
  refund_amount_cents?: number;
  refund_reason?: string;
}

// ── Response types ──────────────────────────────────────────────────────────

export interface TrackLeadResult {
  success: boolean;
  provisional?: boolean;
  message?: string;
}

export interface TrackSaleResult {
  success: boolean;
  /** Present when the sale was attributed and recorded. */
  sale_id?: number | null;
  commission_id?: number | null;
  /** Present (false) when the attribution window had expired. */
  attributed?: boolean;
  reason?: string;
  click_age_days?: number;
  window_days?: number;
  message?: string;
}

export interface TrackRefundResult {
  success: boolean;
  status?: string;
  commission_id?: number;
  message?: string;
  [key: string]: unknown;
}

export type GateStatus = 'pass' | 'fail' | 'unknown';
export type TestChainStatus = 'attributed' | 'unattributed' | 'wrong_partner' | 'pending';

/** GET /api/v1/programs/me/readiness response (readiness.ts ReadinessResult). */
export interface ReadinessResult {
  program_id: number;
  state: 'draft' | 'configuring' | 'ready' | 'integration_verified' | 'live_verified';
  integration_verified: boolean;
  blocker: 'profile' | 'economics' | 'payout' | 'tracking' | 'live' | null;
  gates: {
    profile: { status: GateStatus; next_action?: string };
    economics: { status: GateStatus; next_action?: string };
    payout: { status: GateStatus; mode: 'stripe' | 'manual'; next_action?: string; endpoint?: string };
    tracking: { status: GateStatus; detail?: string; checked_at: string | null; next_action?: string };
    live: {
      status: GateStatus;
      test_chain: { click: TestChainStatus; lead: TestChainStatus; sale: TestChainStatus };
      next_action?: string;
    };
  };
  last_event_at: { click: string | null; lead: string | null; sale: string | null };
  counts_24h: { clicks: number; leads: number; sales: number };
  key_rotated_at: string | null;
  poll: { retry_after_seconds: number };
}

// ── Error ───────────────────────────────────────────────────────────────────

/**
 * Thrown on a non-2xx response. Surfaces both error shapes the API returns:
 *   - tracking endpoints:  { error: "message string" }
 *   - readiness endpoint:  { error: { code, message, retry_after_seconds? } }
 */
export class AffitorApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const { code, message, retryAfterSeconds } = AffitorApiError.parse(body, status);
    super(message);
    this.name = 'AffitorApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.body = body;
  }

  private static parse(
    body: unknown,
    status: number,
  ): { code?: string; message: string; retryAfterSeconds?: number } {
    const err = (body as { error?: unknown })?.error;
    if (typeof err === 'string') {
      return { message: err };
    }
    if (err && typeof err === 'object') {
      const e = err as { code?: string; message?: string; retry_after_seconds?: number };
      return {
        code: e.code,
        message: e.message ?? `Request failed with status ${status}`,
        retryAfterSeconds: e.retry_after_seconds,
      };
    }
    return { message: `Request failed with status ${status}` };
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

export class Affitor {
  private readonly apiKey: string;
  private readonly apiBase: string;

  constructor(apiKey: string, opts: AffitorServerOptions = {}) {
    if (!apiKey) throw new Error('Affitor: an api key is required');
    this.apiKey = apiKey;
    this.apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  }

  /** POST /api/v1/track/lead — server-mode lead (Bearer key). */
  async trackLead(params: TrackLeadParams): Promise<TrackLeadResult> {
    return this.request<TrackLeadResult>('POST', '/api/v1/track/lead', params);
  }

  /** POST /api/v1/track/sale — record a sale + commission for an attributed customer. */
  async trackSale(params: TrackSaleParams): Promise<TrackSaleResult> {
    return this.request<TrackSaleResult>('POST', '/api/v1/track/sale', params);
  }

  /** POST /api/v1/track/refund — reverse the commission for a prior sale. */
  async trackRefund(params: TrackRefundParams): Promise<TrackRefundResult> {
    return this.request<TrackRefundResult>('POST', '/api/v1/track/refund', params);
  }

  /** GET /api/v1/programs/me/readiness — the 5-gate readiness verdict for this key's program. */
  async readiness(opts: { forceRecheck?: boolean } = {}): Promise<ReadinessResult> {
    const query = opts.forceRecheck ? '?force_recheck=true' : '';
    return this.request<ReadinessResult>('GET', `/api/v1/programs/me/readiness${query}`);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.apiBase}${path}`, init);

    let parsed: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throw new AffitorApiError(response.status, parsed);
    }

    return parsed as T;
  }
}
