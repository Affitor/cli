/**
 * Minimal Polar management-API client for `affitor setup polar`. Raw fetch —
 * the CLI doesn't take a dependency on @polar-sh/sdk for three REST calls.
 *
 * Contract (verified against polar.sh/docs 2026-07-05):
 *   - Auth: `Authorization: Bearer <Organization Access Token>`.
 *   - POST  /v1/webhooks/endpoints {url, format:'raw', events[]} → 201 incl.
 *     the server-generated signing `secret`.
 *   - GET   /v1/webhooks/endpoints?page&limit → {items[] (each incl. secret),
 *     pagination:{max_page}} — re-runs recover the secret from here.
 *   - PATCH /v1/webhooks/endpoints/{id} {events} — extend an existing endpoint.
 *   - Sandbox is a separate environment (own tokens): sandbox-api.polar.sh.
 */

export const POLAR_API_PROD = "https://api.polar.sh";
export const POLAR_API_SANDBOX = "https://sandbox-api.polar.sh";

export interface PolarWebhookEndpoint {
  id: string;
  url: string;
  name?: string | null;
  format: string;
  /** Signing secret — returned by create AND list/get (recoverable on re-run). */
  secret: string;
  events: string[];
  enabled?: boolean;
  organization_id?: string;
}

interface ListResponse {
  items: PolarWebhookEndpoint[];
  pagination?: { total_count?: number; max_page?: number };
}

export class PolarAPIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "PolarAPIError";
  }
}

export class PolarAPI {
  constructor(
    private token: string,
    private baseUrl: string = POLAR_API_PROD,
  ) {}

  /** All webhook endpoints on the org (paginates; endpoint count is tiny). */
  async listWebhookEndpoints(): Promise<PolarWebhookEndpoint[]> {
    const items: PolarWebhookEndpoint[] = [];
    let page = 1;
    let maxPage = 1;
    do {
      const res = await this.request<ListResponse>(
        `/v1/webhooks/endpoints?page=${page}&limit=100`,
      );
      items.push(...(res.items ?? []));
      maxPage = res.pagination?.max_page ?? 1;
      page += 1;
    } while (page <= maxPage);
    return items;
  }

  async createWebhookEndpoint(opts: {
    url: string;
    events: string[];
  }): Promise<PolarWebhookEndpoint> {
    return this.request<PolarWebhookEndpoint>("/v1/webhooks/endpoints", {
      method: "POST",
      body: { url: opts.url, format: "raw", events: opts.events },
    });
  }

  /** Extend an existing endpoint's event subscriptions (secret is untouched). */
  async updateWebhookEndpointEvents(
    id: string,
    events: string[],
  ): Promise<PolarWebhookEndpoint> {
    return this.request<PolarWebhookEndpoint>(`/v1/webhooks/endpoints/${id}`, {
      method: "PATCH",
      body: { events },
    });
  }

  private async request<T>(
    path: string,
    opts: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: opts.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": "affitor-cli",
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new PolarAPIError(0, `Network error calling Polar: ${(err as Error).message}`);
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) {
      throw new PolarAPIError(res.status, polarErrorMessage(res.status, body));
    }

    return body as T;
  }
}

/** Human-readable message from Polar's error body (401/403/422 shapes vary). */
function polarErrorMessage(status: number, body: Record<string, unknown>): string {
  if (status === 401) {
    return (
      "Polar rejected the access token (401). Use an Organization Access Token " +
      "(Polar dashboard → Settings → Developers). Sandbox and production tokens " +
      "are separate — pass --sandbox for a sandbox token."
    );
  }
  const detail = body.detail ?? body.error ?? body.message;
  if (typeof detail === "string") return `Polar API ${status}: ${detail}`;
  if (Array.isArray(detail)) {
    // 422 validation errors: [{loc, msg, type}, ...]
    const msgs = detail
      .map((d) => (d && typeof d === "object" && "msg" in d ? (d as { msg: string }).msg : null))
      .filter(Boolean);
    if (msgs.length) return `Polar API ${status}: ${msgs.join("; ")}`;
  }
  return `Polar API returned ${status}`;
}
