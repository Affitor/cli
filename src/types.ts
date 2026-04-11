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
  stripe_connected: boolean;
  stripe_account_id?: string;
  api_key: string;
  api_url: string;
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

export interface TestEventResult {
  event_type: "click" | "lead" | "sale";
  event_id: string;
  received: boolean;
  attributed: boolean;
  message: string;
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
