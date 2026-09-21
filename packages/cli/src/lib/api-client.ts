import { DEFAULT_API_URL } from "../types.js";
import type {
  InitResponse,
  StripeConnectResponse,
  ProgramStatus,
  ProgramSummary,
  TestEventResult,
  ReadinessResult,
  VerificationChainResult,
} from "../types.js";
import * as logger from "./logger.js";
import { resolveApiKey } from "./config.js";

export interface AuthStartResponse {
  state: string;
  auth_url: string;
  poll_url: string;
  expires_at: string;
}

export interface AuthPollResponse {
  status: "pending" | "complete" | "expired" | "consumed";
  token?: string;
  email?: string;
  advertiser_id?: number;
}

interface RequestOptions {
  method?: string;
  body?: Record<string, unknown>;
  apiKey?: string;
  apiUrl?: string;
}

/**
 * A non-fatal notice the API attaches to a response, next to `data` rather than
 * inside it — and on an error response as much as on a successful one. A key
 * flagged for replacement is the first one: requests keep working until the
 * deadline and carry the warning every time.
 */
interface APIWarning {
  code: string;
  message: string;
  hint?: string;
  docs_url?: string;
}

/**
 * The dedupe key the body warning and the response headers share. Both say the same
 * thing about the same key, so whichever arrives first speaks and the other stays
 * quiet — the body wins when it is there, because it carries a hint as well.
 */
const ROTATION_KEY = "api_key_rotation_required";

/** The `Sunset` deadline as a plain date, or undefined if it will not parse. */
function parseSunset(sunset: string | null | undefined): string | undefined {
  if (!sunset) return undefined;
  const at = new Date(sunset);
  // An unparseable date is a signal we cannot use, not a reason to fail the command.
  if (Number.isNaN(at.getTime())) return undefined;
  return at.toISOString().slice(0, 10);
}

/** The URL out of `Link: <url>; rel="deprecation"`, ignoring links with any other rel. */
function parseDeprecationLink(link: string | null | undefined): string | undefined {
  if (!link) return undefined;
  for (const entry of link.split(",")) {
    if (!/rel\s*=\s*"?deprecation"?/i.test(entry)) continue;
    const url = /<([^>]+)>/.exec(entry);
    if (url) return url[1].trim();
  }
  return undefined;
}

export class AffitorAPI {
  private apiUrl: string;
  private apiKey?: string;
  /**
   * Warning codes this client has already printed. A flagged key warns on every
   * response, so one command would otherwise print the same line once per request
   * it makes. A command builds one client, so this lasts exactly one run: a second
   * client, or a second run in the same process, warns again.
   */
  private reportedWarnings = new Set<string>();

  constructor(opts: { apiUrl?: string; apiKey?: string } = {}) {
    this.apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
    this.apiKey = opts.apiKey;
  }

  /**
   * Create an API client with auto-resolved credentials.
   * Priority: --api-key flag > AFFITOR_API_KEY env > .affitor/.env > legacy config
   */
  static fromFlags(flags: { apiKey?: string; apiUrl?: string }, cwd?: string): AffitorAPI {
    const apiKey = resolveApiKey(flags, cwd);
    return new AffitorAPI({
      apiUrl: flags.apiUrl ?? DEFAULT_API_URL,
      apiKey: apiKey ?? undefined,
    });
  }

  async initProgram(data: {
    name: string;
    domain: string;
    commission_type: string;
    commission_rate: number;
    cookie_duration: number;
    duration_months?: number;
    advertiser_id?: number;
  }): Promise<InitResponse> {
    return this.request<InitResponse>("/api/v1/cli/init", {
      method: "POST",
      body: data,
    });
  }

  async saveStripeConnection(data: {
    program_id: string;
    stripe_user_id: string;
    webhook_endpoint_id: string;
    webhook_secret: string;
  }): Promise<StripeConnectResponse> {
    return this.request<StripeConnectResponse>("/api/v1/cli/stripe-connect", {
      method: "POST",
      body: data,
    });
  }

  async getStatus(programId: string): Promise<ProgramStatus> {
    return this.request<ProgramStatus>(
      `/api/v1/cli/status?program_id=${programId}`,
    );
  }

  // ─── Auth endpoints ───────────────────────────────────────────

  async authStart(): Promise<AuthStartResponse> {
    return this.request<AuthStartResponse>("/api/v1/cli/auth/start", {
      method: "POST",
    });
  }

  async authPoll(state: string): Promise<AuthPollResponse> {
    return this.request<AuthPollResponse>(
      `/api/v1/cli/auth/poll?state=${encodeURIComponent(state)}`,
    );
  }

  // ─── Program endpoints ──────────────────────────────────────────

  async listPrograms(): Promise<ProgramSummary[]> {
    return this.request<ProgramSummary[]>("/api/v1/cli/programs");
  }

  async sendTestEvent(data: {
    program_id: string;
    event_type: "click" | "lead" | "sale";
  }): Promise<TestEventResult> {
    return this.request<TestEventResult>("/api/v1/cli/test-event", {
      method: "POST",
      body: data,
    });
  }

  // ─── Onboarding / verification endpoints ────────────────────────

  /**
   * GET /api/v1/programs/me/readiness — the per-program 5-gate verdict
   * (Bearer key). `integration_verified` flips true when every gate passes;
   * the blocking gate's `next_action` tells the caller what to fix.
   */
  async getReadiness(opts: { apiKey?: string; apiUrl?: string } = {}): Promise<ReadinessResult> {
    return this.request<ReadinessResult>("/api/v1/programs/me/readiness", {
      apiKey: opts.apiKey,
      apiUrl: opts.apiUrl,
    });
  }

  /**
   * POST /api/v1/cli/test-event {type:'chain'} — fire the synthetic
   * click→lead→sale chain through the REAL attribution pipeline (isolated
   * is_test rows). Mirrors the MCP `fireVerificationChain` contract exactly.
   *
   * Does NOT use the shared `request()` helper because that throws on 429. A
   * 429 here is expected (the chain is rate-limited to 10/program/hour) and the
   * caller must read `retry_after_seconds` and back off — so on a non-2xx this
   * returns the parsed body (with `rate_limited` + `retry_after_seconds` merged
   * in for 429) instead of throwing. Only a network/parse failure throws.
   */
  async runVerificationChain(
    opts: { apiKey?: string; apiUrl?: string } = {},
  ): Promise<VerificationChainResult> {
    const apiUrl = opts.apiUrl ?? this.apiUrl;
    const key = opts.apiKey ?? this.apiKey;
    const url = `${apiUrl}/api/v1/cli/test-event`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "affitor-cli/0.2.0",
    };
    if (key) headers["Authorization"] = `Bearer ${key}`;

    logger.debug(`POST ${url} {type:'chain'}`);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "chain" }),
      });
    } catch (err) {
      throw new NetworkError((err as Error).message);
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    this.reportWarnings(body);
    this.reportDeprecationHeaders(res);

    if (res.ok) {
      // Server returns { data: { verdict, attributed, ... } } or the bare object.
      return (body.data ?? body) as VerificationChainResult;
    }

    // Non-2xx (incl. 429): DO NOT throw — surface the parsed body so the caller
    // can read retry_after_seconds and back off. Mirror MCP fireVerificationChain.
    const errObj = (body.error ?? {}) as { code?: string; retry_after_seconds?: number };
    const retryHeader = res.headers.get("Retry-After");
    const retryAfter =
      errObj.retry_after_seconds ?? (retryHeader ? parseInt(retryHeader, 10) : undefined);

    return {
      ...(body as VerificationChainResult),
      http_status: res.status,
      rate_limited: res.status === 429 || errObj.code === "rate_limited",
      ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
    };
  }

  /** Forget which warnings this client has printed, so they are printed again. */
  resetReportedWarnings(): void {
    this.reportedWarnings.clear();
  }

  /** Print each new `warnings[]` entry as one stderr line: what is wrong, what to do. */
  private reportWarnings(body: unknown): void {
    const warnings = (body as { warnings?: unknown } | null)?.warnings;
    if (!Array.isArray(warnings)) return;

    for (const warning of warnings as APIWarning[]) {
      if (!warning?.message) continue;
      const key = warning.code ?? warning.message;
      if (this.reportedWarnings.has(key)) continue;
      this.reportedWarnings.add(key);
      logger.notice(warning.hint ? `${warning.message} ${warning.hint}` : warning.message);
    }
  }

  /**
   * Print the rotation signal the API sets in headers on EVERY response made with a
   * flagged key — `Deprecation` (RFC 9745), `Sunset` (RFC 8594) and a `deprecation`
   * link. Past the deadline the API answers 401 and drops `warnings[]`, so these
   * headers are the only thing left saying why (W37-1362).
   *
   * Shares `reportedWarnings` with the body warning under one key, so a response
   * carrying both prints once. Anything missing or unparseable is skipped in
   * silence: a side signal must never break a command that is otherwise working.
   */
  private reportDeprecationHeaders(res: Response): void {
    let deprecation: string | null = null;
    let sunset: string | null = null;
    let link: string | null = null;
    try {
      deprecation = res.headers?.get("Deprecation") ?? null;
      sunset = res.headers?.get("Sunset") ?? null;
      link = res.headers?.get("Link") ?? null;
    } catch {
      return;
    }

    if (!deprecation && !sunset) return;
    if (this.reportedWarnings.has(ROTATION_KEY)) return;
    this.reportedWarnings.add(ROTATION_KEY);

    const by = parseSunset(sunset);
    const docs = parseDeprecationLink(link);
    logger.notice(
      [
        by ? `This API key must be replaced by ${by}.` : "This API key must be replaced.",
        docs ? `See ${docs}` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = `${opts.apiUrl ?? this.apiUrl}${path}`;
    const key = opts.apiKey ?? this.apiKey;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "affitor-cli/0.2.0",
    };
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    }

    logger.debug(`${opts.method ?? "GET"} ${url}`);

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: opts.method ?? "GET",
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });

        // `warnings` sits beside `data`, and the API attaches it to an error
        // response too: a key inside its rotation window still has to hear about
        // the deadline while a call fails for an unrelated reason. So read the
        // body once and report before branching on status. A body that will not
        // parse only matters on a 2xx, where it was the payload.
        let body: unknown = {};
        let bodyError: unknown;
        try {
          body = await res.json();
        } catch (err) {
          bodyError = err;
        }
        this.reportWarnings(body);
        // After the body, so the richer body warning claims the shared key, and
        // before every branch below, so a 429 or a 401 reports too — the 401 past
        // the deadline has nothing but these headers.
        this.reportDeprecationHeaders(res);

        if (res.status === 429) {
          const retryAfter = res.headers.get("Retry-After");
          const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
          throw new APIError(
            429,
            `Rate limited. Wait ${Math.ceil(wait / 1000)} seconds and try again.`,
          );
        }

        if (!res.ok) {
          const errorBody = (body ?? {}) as {
            error?: string | { message?: string; code?: string; hint?: string };
            message?: string;
          };
          // Strapi returns errors as an object ({ error: { message, ... } }),
          // but some endpoints return { error: "string" } or { message }.
          // Extract a string so we never surface "[object Object]".
          const rawError = errorBody.error;
          const errObject = typeof rawError === "object" && rawError !== null ? rawError : undefined;
          const message =
            (typeof rawError === "string" ? rawError : errObject?.message) ??
            errorBody.message ??
            `API returned ${res.status}`;
          // A `hint` means the caller has to do something specific rather than retry
          // (a retired key needs a new key), so keep it attached to the message, and
          // keep `code` so a command can tell that case from a plain bad key.
          throw new APIError(
            res.status,
            errObject?.hint ? `${message} ${errObject.hint}` : message,
            errObject?.code,
          );
        }

        if (bodyError) throw bodyError;
        return (body as { data?: T }).data ?? (body as T);
      } catch (err) {
        if (err instanceof APIError) throw err;
        lastError = err as Error;
        if (attempt < 3) {
          const wait = attempt * 1000;
          logger.debug(`Request failed, retrying in ${wait}ms...`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }

    throw new NetworkError(lastError?.message ?? "Request failed after 3 attempts");
  }
}

export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The API's own error code, when it sent one (e.g. api_key_rotation_required). */
    public code?: string,
  ) {
    super(message);
    this.name = "APIError";
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(`Network error: ${message}.\nCheck your internet connection and try again.`);
    this.name = "NetworkError";
  }
}
