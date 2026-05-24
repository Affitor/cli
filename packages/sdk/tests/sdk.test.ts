import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AffitorTracker, signup } from '../src/index';

const API = 'https://api.test';

function setUrl(path: string): void {
  window.history.replaceState({}, '', path);
}

function clearCookies(): void {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearCookies();
  setUrl('/');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AffitorTracker.trackClick', () => {
  it('posts the same click payload + endpoint as the legacy script, and persists the cookie', async () => {
    setUrl('/?aff=PARTNER123');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ click_id: 'clk_1', cookie_window_days: 30 }),
    });

    const t = new AffitorTracker({ programId: 123, apiBase: API });
    await t.trackClick('http://localhost/?aff=PARTNER123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/api/v1/track/click`);
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      affiliate_url: 'http://localhost/?aff=PARTNER123',
      page_url: 'http://localhost/?aff=PARTNER123',
    });
    for (const key of [
      'page_title', 'referrer_url', 'session_id', 'user_agent',
      'screen_resolution', 'viewport_size', 'language', 'timezone',
    ]) {
      expect(body).toHaveProperty(key);
    }
    expect(body.session_id).toMatch(/^sess_/);

    // Cookie persisted (both the new and legacy names), click id exposed.
    expect(t.getClickId()).toBe('clk_1');
    expect(document.cookie).toContain('affitor_click_id=clk_1');
    expect(document.cookie).toContain('customer_code=clk_1');
  });
});

describe('AffitorTracker.signup', () => {
  it('posts the lead payload with click_id + program_id to /track/lead', async () => {
    document.cookie = 'affitor_click_id=clk_existing; path=/';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    const t = new AffitorTracker({ programId: 77, apiBase: API });
    await t.signup('cust_9', 'x@y.com');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/api/v1/track/lead`);
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      customer_key: 'cust_9',
      email: 'x@y.com',
      click_id: 'clk_existing',
      program_id: 77,
    });
  });
});

describe('AffitorTracker.init (attribution)', () => {
  it('fires a click when landing on an ?aff= URL', () => {
    setUrl('/?aff=NEWPARTNER');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ click_id: 'clk_2' }) });

    const t = new AffitorTracker({ programId: 1, apiBase: API });
    t.init({ programId: 1, apiBase: API });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/api/v1/track/click`);
  });

  it('reuses an existing cookie without re-tracking a click', () => {
    document.cookie = 'affitor_click_id=clk_existing; path=/';
    setUrl('/dashboard');

    const t = new AffitorTracker({ programId: 5, apiBase: API });
    t.init({ programId: 5, apiBase: API });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(t.getClickId()).toBe('clk_existing');
    expect(t.getData().hasAttribution).toBe(true);
  });
});

describe('functional facade', () => {
  it('signup() before init() resolves without throwing or fetching', async () => {
    await expect(signup('cust', 'e@x.com')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
