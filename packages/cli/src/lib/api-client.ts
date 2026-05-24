import { DEFAULT_API_URL } from "../types.js";
import type {
  InitResponse,
  StripeConnectResponse,
  ProgramStatus,
  ProgramSummary,
  TestEventResult,
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
          const body = await res.json().catch(() => ({}));
          const message =
            (body as Record<string, string>).error ??
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
