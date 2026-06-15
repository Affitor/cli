export interface AffitorConfig {
  version: number;
  program_id: string;
  domain: string;
  tracking_subdomain: string;
  commission: {
    type: CommissionType;
    rate: number;
    duration_months?: number;
  };
  cookie: {
    name: string;
    duration_days: number;
  };
  ref_param: string;
  stripe_connected?: boolean;
  stripe_account_id?: string;
  api_url: string;
  created_at: string;
  // v1 only — removed in v2 (moved to .affitor/.env)
  api_key?: string;
}

export interface AffitorSecrets {
  api_key: string;
  program_id: string;
  stripe_account_id?: string;
}

export interface UserCredentials {
  token: string;
  email: string;
  user_id: string;
  advertiser_id: string;
  expires_at: string;
  created_at: string;
}

export type CommissionType =
  | "percent"
  | "fixed"
  | "recurring_percent"
  | "recurring_fixed";

export interface InitOptions {
  name: string;
  domain: string;
  commissionType: CommissionType;
  commissionRate: number;
  cookieDuration: number;
  durationMonths?: number;
}

export interface InitResponse {
  program_id: string;
  api_key: string;
  program_slug: string;
  domain: string;
}

export interface StripeConnectResponse {
  connected: boolean;
  stripe_account_id: string;
  webhook_endpoint_id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
}

export interface ProgramStatus {
  program_id: string;
  name: string;
  domain: string;
  dns_verified: boolean;
  stripe_connected: boolean;
  stripe_charges_enabled?: boolean;
  recent_events: {
    clicks_24h: number;
    leads_24h: number;
    sales_24h: number;
  };
  active_partners: number;
  pending_commissions: number;
}

export interface ProgramSummary {
  id: number;
  name: string;
  domain: string;
  status: string;
  commission: string;
  partners: number;
  created_at: string;
}

export interface TestEventResult {
  event_type: "click" | "lead" | "sale";
  event_id: string;
  received: boolean;
  attributed: boolean;
  message: string;
}

/**
 * Per-step status of the synthetic click→lead→sale chain, as returned by the CMS
 * (`TestChainStatus`). A step is "passing" ONLY when it equals `'attributed'`;
 * every other value (`unattributed`/`wrong_partner`/`pending`) is a failure or
 * not-yet-resolved state and must NOT be rendered as success.
 */
export type TestChainStatus = "attributed" | "unattributed" | "wrong_partner" | "pending";

/** The keyed gate id set returned by readiness (the CMS `ReadinessResult.gates`). */
export type ReadinessGateId = "profile" | "economics" | "payout" | "tracking" | "live";

/** The mode the payout gate reports. */
export type PayoutMode = "stripe" | "s2s" | "manual";

/**
 * A single readiness gate verdict from GET /api/v1/programs/me/readiness.
 * `status` is the tri-state the CMS returns; `next_action` (when present) tells
 * the caller what to fix to move the gate to `'pass'`.
 */
export interface ReadinessGate {
  status: "pass" | "fail" | "unknown";
  next_action?: string;
  /** payout gate only. */
  mode?: PayoutMode;
  endpoint?: string;
  /** tracking gate only. */
  detail?: string;
  checked_at?: string;
  /** live gate only — per-step verdict of the last synthetic chain. */
  test_chain?: { click: TestChainStatus; lead: TestChainStatus; sale: TestChainStatus };
}

/**
 * GET /api/v1/programs/me/readiness verdict. `gates` is a KEYED OBJECT (NOT an
 * array): each gate has a tri-state `status`. `integration_verified` flips true
 * once every gate passes; `blocker` is the id of the FIRST failing gate (or
 * `null`), so the CLI reads `gates[blocker].next_action` to tell the user what
 * to fix. Mirrors the CMS `ReadinessResult` shape exactly.
 */
export interface ReadinessResult {
  integration_verified: boolean;
  state?: string;
  gates?: Partial<Record<ReadinessGateId, ReadinessGate>>;
  blocker?: ReadinessGateId | null;
  poll?: { retry_after_seconds: number };
  [key: string]: unknown;
}

/**
 * Result of the synthetic verification chain (POST /api/v1/cli/test-event
 * {type:'chain'}). On a 2xx the server returns `{ data: { type:'chain',
 * short_code, customer_key, verdict, attributed } }`. Each verdict value is a
 * `TestChainStatus` STRING (not a boolean); `attributed === (verdict.sale ===
 * 'attributed')`. On a 429 the client returns the parsed rate-limit body instead
 * of throwing, so the caller can read `retry_after_seconds` and back off.
 */
export interface VerificationVerdict {
  click?: TestChainStatus;
  lead?: TestChainStatus;
  sale?: TestChainStatus;
}

export interface VerificationChainResult {
  type?: "chain";
  short_code?: string;
  customer_key?: string;
  verdict?: VerificationVerdict;
  attributed?: boolean;
  rate_limited?: boolean;
  retry_after_seconds?: number;
  error?: { code?: string; retry_after_seconds?: number; message?: string };
  [key: string]: unknown;
}

export interface CLIFlags {
  json: boolean;
  noInteractive: boolean;
  autoConfirm: boolean;
  quiet: boolean;
  apiKey?: string;
  apiUrl?: string;
  verbose: boolean;
}

export const API_URL_PROD = "https://api.affitor.com";
export const API_URL_UAT = "https://uat-affitor-cms.vanilla-ott.com";
export const DEFAULT_API_URL = API_URL_PROD;
export const CONFIG_DIR = ".affitor";
export const CONFIG_FILE = "config.json";
export const SECRETS_FILE = ".env";
export const GLOBAL_CONFIG_DIR = ".affitor";
export const CREDENTIALS_FILE = "credentials.json";
export const OAUTH_CALLBACK_PORT_START = 3456;
export const OAUTH_CALLBACK_PORT_END = 3465;
export const OAUTH_TIMEOUT_MS = 120_000;

export const WEBHOOK_EVENTS = [
  "customer.created",
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded",
  "customer.subscription.deleted",
] as const;
