# affitor-sdk

Affitor browser tracking SDK — typed `init()` / `signup()` for affiliate attribution.

Wraps the Affitor tracker: captures `?aff=` attribution, stores the click id in a
first-party cookie (`affitor_click_id`), and reports click + lead (signup) events.
Same endpoints and payloads as the legacy `affitor-tracker.js` script.

## Install

```bash
npm i affitor-sdk
```

## Usage

```ts
import { init, signup } from 'affitor-sdk';

// On app load (client-side):
init({ programId: 123 });

// At signup / checkout:
await signup('customer_123', 'user@example.com');
```

SSR-safe: `init()` is a no-op on the server, so importing it anywhere in a
Next.js / SSR app is safe.

### Options

| Option | Type | Description |
|---|---|---|
| `programId` | `number \| string` | Affiliate program id. |
| `debug` | `boolean` | Verbose console logging. |
| `cookieDomain` | `string` | Force a cookie domain (e.g. `.example.com`). Auto-detected otherwise. |
| `apiBase` | `string` | Override the tracking API base (default `https://api.affitor.com`). |

### API

- `init(options)` — start attribution (captures `?aff=`, loads/sets the cookie).
- `signup(customerKey, email?)` — track a lead/signup.
- `trackClick(affiliateUrl?, existingClickId?)` — track a click manually.
- `getClickId()` — current click id, or `null`.
- `getData()` — `{ clickId, programId, hasAttribution, affiliateUrl }`.

A class export (`AffitorTracker`) is also available for multi-instance use.
