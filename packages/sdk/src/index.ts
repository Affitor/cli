/**
 * @affitor/sdk — Affitor browser tracking SDK
 *
 * Typed npm package wrapping the Affitor tracker. Captures `?aff=` attribution,
 * persists the click id in a first-party cookie, and reports click + lead
 * (signup) events. Behaviour mirrors the legacy `affitor-tracker.js` script:
 * same endpoints, same payloads, same `affitor_click_id` cookie.
 *
 * Usage:
 *   import { init, signup } from '@affitor/sdk';
 *   init({ programId: 123 });                       // on app load (client-side)
 *   await signup('customer_123', 'user@example.com'); // at signup/checkout
 *
 * SSR-safe: `init()` is a no-op on the server (no `window`/`document` access at
 * import time), so it can be imported anywhere in a Next.js / SSR app.
 */

const DEFAULT_API_BASE = 'https://api.affitor.com';
const CLICK_ID_COOKIE = 'affitor_click_id';
const AFF_URL_COOKIE = 'affitor_aff_url';
const LEGACY_CLICK_ID_COOKIE = 'customer_code';
const DEFAULT_COOKIE_EXPIRE_DAYS = 60;

export interface AffitorInitOptions {
  /** Affiliate program id. Falls back to a `data-affitor-program-id` script tag or `window.AFFITOR_PROGRAM_ID`. */
  programId?: number | string;
  /** Verbose console logging. */
  debug?: boolean;
  /** Force a cookie domain (e.g. `.example.com`). Auto-detected when omitted. */
  cookieDomain?: string;
  /** Override the tracking API base. Defaults to https://api.affitor.com. */
  apiBase?: string;
}

export interface AffitorData {
  clickId: string | null;
  programId: number | null;
  hasAttribution: boolean;
  affiliateUrl: string | null;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

export class AffitorTracker {
  private sessionId: string;
  private debugMode = false;
  private loaded = false;
  private clickId: string | null = null;
  private affiliateUrl: string | null = null;
  private hasAffiliateAttribution = false;
  private cookieDomain: string | null = null;
  private cookieExpireDays = DEFAULT_COOKIE_EXPIRE_DAYS;
  private apiBase = DEFAULT_API_BASE;
  programId: number | null = null;

  constructor(options: AffitorInitOptions = {}) {
    this.sessionId = this.generateSessionId();
    if (options.apiBase) this.apiBase = options.apiBase;
    if (options.cookieDomain) this.cookieDomain = options.cookieDomain;
    this.programId = this.resolveProgramId(options.programId);
  }

  private resolveProgramId(optionsProgramId?: number | string): number | null {
    if (optionsProgramId !== undefined && optionsProgramId !== null && `${optionsProgramId}` !== '') {
      return parseInt(`${optionsProgramId}`, 10);
    }
    if (!isBrowser()) return null;

    const script = document.querySelector(
      'script[data-affitor-program-id], script[data-affitor-program]'
    );
    if (script) {
      const dataProgramId =
        script.getAttribute('data-affitor-program-id') || script.getAttribute('data-affitor-program');
      if (dataProgramId) return parseInt(dataProgramId, 10);
    }

    const globalProgramId = (window as any).AFFITOR_PROGRAM_ID;
    if (globalProgramId) return parseInt(`${globalProgramId}`, 10);

    this.log('error', 'Affitor program ID not found — set it via init({ programId }).');
    return null;
  }

  init(options: AffitorInitOptions = {}): void {
    this.debugMode = options.debug || false;
    if (options.apiBase) this.apiBase = options.apiBase;
    if (options.programId !== undefined) this.programId = this.resolveProgramId(options.programId);
    if (options.cookieDomain) this.cookieDomain = options.cookieDomain;
    this.loaded = true;

    this.log('info', 'Affitor SDK initialized:', options);
    this.log('info', 'Using program ID:', this.programId);

    this.initializeAffiliateAttribution();
  }

  private extractAffFromUrl(url: string | null): string | null {
    if (!url) return null;
    try {
      return new URL(url).searchParams.get('aff');
    } catch {
      const match = url.match(/[?&]aff=([^&]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    }
  }

  /**
   * Initialize affiliate attribution by checking `?aff=` URLs and cookies.
   * Last-partner attribution: a new partner overwrites an existing one.
   */
  initializeAffiliateAttribution(): void {
    if (!isBrowser()) return;

    const currentUrl = window.location.href;
    const currentAff = this.extractAffFromUrl(currentUrl);

    if (currentAff !== null) {
      const existingClickId = this.getClickIdFromCookie();
      const existingAffUrl = this.getCookie(AFF_URL_COOKIE);
      const existingAff = this.extractAffFromUrl(existingAffUrl);

      const isNewPartner = existingAff !== null && currentAff !== existingAff;
      const needsTracking = !existingClickId || isNewPartner;

      if (needsTracking) {
        void this.trackClick(currentUrl, isNewPartner ? existingClickId : null);
        this.affiliateUrl = currentUrl;
      } else {
        this.clickId = existingClickId;
        this.affiliateUrl = existingAffUrl;
        this.hasAffiliateAttribution = true;
      }
    } else {
      const existingClickId = this.getClickIdFromCookie();
      if (existingClickId) {
        this.clickId = existingClickId;
        this.affiliateUrl = this.getCookie(AFF_URL_COOKIE);
        this.hasAffiliateAttribution = true;
      }
    }
  }

  /** Root domain for cross-subdomain cookie sharing (e.g. shop.example.com → .example.com). */
  private getRootDomain(): string | null {
    if (this.cookieDomain) return this.cookieDomain;
    if (!isBrowser()) return null;

    const hostname = window.location.hostname;
    if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return null;

    const parts = hostname.split('.');
    for (let i = parts.length - 2; i >= 0; i--) {
      const candidate = '.' + parts.slice(i).join('.');
      document.cookie = `affitor_domain_test=1; domain=${candidate}; path=/`;
      if (document.cookie.indexOf('affitor_domain_test') !== -1) {
        document.cookie = `affitor_domain_test=; domain=${candidate}; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
        this.cookieDomain = candidate;
        return candidate;
      }
    }
    return null;
  }

  private setCookie(name: string, value: string): void {
    if (!isBrowser()) return;
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + this.cookieExpireDays);

    const domain = this.getRootDomain();
    let cookieValue = `${name}=${value}; expires=${expirationDate.toUTCString()}; path=/; SameSite=Lax`;
    if (domain) cookieValue += `; domain=${domain}`;
    if (window.location.protocol === 'https:') cookieValue += '; Secure';
    document.cookie = cookieValue;
  }

  private getCookie(name: string): string | null {
    if (!isBrowser()) return null;
    for (const cookie of document.cookie.split(';')) {
      const trimmed = cookie.trim();
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      if (trimmed.substring(0, eqIndex) === name) return trimmed.substring(eqIndex + 1);
    }
    return null;
  }

  /** Click id from cookie, migrating the legacy `customer_code` cookie if present. */
  private getClickIdFromCookie(): string | null {
    const clickId = this.getCookie(CLICK_ID_COOKIE);
    if (clickId) return clickId;

    const legacyClickId = this.getCookie(LEGACY_CLICK_ID_COOKIE);
    if (legacyClickId) {
      this.setCookie(CLICK_ID_COOKIE, legacyClickId);
      return legacyClickId;
    }
    return null;
  }

  /** Track a click when the user lands on an `?aff=` URL. */
  async trackClick(affiliateUrl?: string, existingClickId: string | null = null): Promise<void> {
    if (!isBrowser()) return;
    try {
      const payload: Record<string, unknown> = {
        affiliate_url: affiliateUrl ?? window.location.href,
        page_url: window.location.href,
        page_title: document.title,
        referrer_url: document.referrer,
        session_id: this.sessionId,
        user_agent: navigator.userAgent,
        screen_resolution: `${screen.width}x${screen.height}`,
        viewport_size: `${window.innerWidth}x${window.innerHeight}`,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      if (existingClickId) payload.existing_click_id = existingClickId;

      const response = await fetch(`${this.apiBase}/api/v1/track/click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.click_id) {
          if (data.cookie_window_days) this.cookieExpireDays = data.cookie_window_days;
          this.clickId = data.click_id;
          this.setCookie(CLICK_ID_COOKIE, data.click_id);
          this.setCookie(LEGACY_CLICK_ID_COOKIE, data.click_id); // legacy integrations
          this.setCookie(AFF_URL_COOKIE, payload.affiliate_url as string);
          this.hasAffiliateAttribution = true;
          this.log('info', 'Click tracked, click_id saved:', data.click_id);
        }
      } else {
        this.log('info', 'Failed to track click:', response.status, response.statusText);
      }
    } catch (error) {
      this.log('info', 'Error tracking click:', error);
    }
  }

  /**
   * Track a signup (lead) event.
   * @param customerKey - the advertiser's unique customer identifier
   * @param email - customer email (hashed server-side)
   */
  async signup(customerKey: string, email?: string): Promise<void> {
    if (!isBrowser()) return;
    if (!customerKey) this.log('error', 'signup() requires customerKey as first argument');
    if (!this.hasAffiliateAttribution) this.log('info', 'Signup tracked without affiliate attribution');

    try {
      const payload = {
        customer_key: customerKey || null,
        email: email || null,
        click_id: this.clickId || this.getClickIdFromCookie() || null,
        page_url: window.location.href,
        session_id: this.sessionId,
        program_id: this.programId,
        has_attribution: this.hasAffiliateAttribution,
        debug_mode: this.debugMode,
      };

      const response = await fetch(`${this.apiBase}/api/v1/track/lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        this.log('info', 'Signup tracked successfully');
      } else {
        this.log('error', 'Failed to track signup:', response.status);
      }
    } catch (error) {
      this.log('error', 'Error tracking signup:', error);
    }
  }

  /** Current click id (memory or cookie). */
  getClickId(): string | null {
    return this.clickId || this.getClickIdFromCookie() || null;
  }

  /** Snapshot of tracker state. */
  getData(): AffitorData {
    return {
      clickId: this.getClickId(),
      programId: this.programId,
      hasAttribution: this.hasAffiliateAttribution,
      affiliateUrl: this.affiliateUrl,
    };
  }

  private generateSessionId(): string {
    return 'sess_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
  }

  private log(type: 'info' | 'warn' | 'error', ...args: unknown[]): void {
    if (type === 'error') {
      console.error('[Affitor]', ...args);
      return;
    }
    if (this.debugMode) {
      if (type === 'warn') console.warn('[Affitor]', ...args);
      else console.log('[Affitor]', ...args);
    }
  }
}

// ── Functional facade over a module-level singleton ─────────────────────────
// Mirrors `window.affitor.*`. Safe to import in SSR contexts; methods no-op on
// the server and warn (but never throw) if called before init() in the browser.

let _instance: AffitorTracker | null = null;

/** Initialize tracking. No-op on the server. Returns the tracker (or null on the server). */
export function init(options: AffitorInitOptions = {}): AffitorTracker | null {
  if (!isBrowser()) return null;
  if (!_instance) _instance = new AffitorTracker(options);
  _instance.init(options);
  return _instance;
}

/** Track a signup (lead). */
export function signup(customerKey: string, email?: string): Promise<void> {
  if (!_instance) {
    if (isBrowser()) console.error('[Affitor] signup() called before init()');
    return Promise.resolve();
  }
  return _instance.signup(customerKey, email);
}

/** Track a click. */
export function trackClick(affiliateUrl?: string, existingClickId: string | null = null): Promise<void> {
  if (!_instance) {
    if (isBrowser()) console.error('[Affitor] trackClick() called before init()');
    return Promise.resolve();
  }
  return _instance.trackClick(affiliateUrl, existingClickId);
}

/** Current click id, or null. */
export function getClickId(): string | null {
  return _instance?.getClickId() ?? null;
}

/** Tracker state snapshot, or null before init. */
export function getData(): AffitorData | null {
  return _instance?.getData() ?? null;
}

/** The underlying tracker instance (advanced use), or null before init. */
export function getTracker(): AffitorTracker | null {
  return _instance;
}
