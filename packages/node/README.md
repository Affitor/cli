# @affitor/node

Affitor **server-side** SDK — typed `trackLead()` / `trackSale()` over the Affitor
conversion API. Provider-agnostic: works with Stripe, Polar, Lemon Squeezy, Paddle,
or any payment processor.

## Install

```bash
npm i @affitor/node
```

## Usage

```ts
import { Affitor } from '@affitor/node';

const affitor = new Affitor({ apiKey: process.env.AFFITOR_API_KEY! });

// At signup — binds the customer to the affiliate click:
await affitor.trackLead({ customerExternalId: user.id, clickId });

// At purchase (e.g. inside your Polar / Lemon Squeezy / Stripe webhook handler):
await affitor.trackSale({
  customerExternalId: user.id,   // resolves attribution — no clickId needed once bound
  amount: 4999,                  // integer cents
  invoiceId: order.id,           // idempotency key
  saleType: 'subscription',
  isRecurring: true,
  subscriptionInterval: 'monthly',
});
```

**Attribution model (Dub-style):** bind the customer at lead time
(`customerExternalId ↔ clickId`), then a sale only needs `customerExternalId`.
No need to thread the click id through a Merchant-of-Record checkout.

Server-side only — the program API key is a secret; never ship it to a browser.
For browser click/lead capture use [`@affitor/sdk`](../sdk).

## API

| Method | Endpoint | Auth |
|---|---|---|
| `trackLead({ customerExternalId, clickId, email? })` | `POST /api/v1/track/lead` | Bearer |
| `trackSale({ customerExternalId, amount, invoiceId, currency?, saleType?, isRecurring?, subscriptionId?, subscriptionInterval? })` | `POST /api/v1/track/sale` | Bearer |
| `trackClick({ affiliateUrl?, ... })` | `POST /api/v1/track/click` | public |

Methods resolve to `{ ok, status, data, error }` (they don't reject on HTTP/network
errors). Programmer errors (missing `apiKey`, invalid `amount`/`invoiceId`) throw.

Options: `new Affitor({ apiKey, apiUrl?, fetch? })` — `apiUrl` defaults to
`https://api.affitor.com`; pass `fetch` for Node < 18 or testing.
