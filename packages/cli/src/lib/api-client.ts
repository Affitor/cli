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

export class AffitorAPI {
  private apiUrl: string;
  private apiKey?: string;

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

        if (res.status === 429) {
          const retryAfter = res.headers.get("Retry-After");
          const wait = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
          throw new APIError(
            429,
            `Rate limited. Wait ${Math.ceil(wait / 1000)} seconds and try again.`,
          );
        }

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string | { message?: string };
            message?: string;
          };
          // Strapi returns errors as an object ({ error: { message, ... } }),
          // but some endpoints return { error: "string" } or { message }.
          // Extract a string so we never surface "[object Object]".
          const rawError = body.error;
          const message =
            (typeof rawError === "string" ? rawError : rawError?.message) ??
            body.message ??
            `API returned ${res.status}`;
          throw new APIError(res.status, message);
        }

        const body = await res.json();
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
