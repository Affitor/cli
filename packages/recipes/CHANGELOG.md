# Changelog: @affitor/recipes

## 0.1.1
- The Stripe Checkout sale snippet reports a sale only when the session carries an Affitor customer key; without one it logs a warning and returns, so your webhook never fails and Stripe never retries it.
- The Stripe renewal snippet does the same for subscriptions started without an Affitor key, and reads the Stripe Basil path (`invoice.parent.subscription_details`) first.
- The Paddle sale snippet skips orders with no `custom_data.user_id` or a $0 total instead of throwing inside your webhook.
- No change to exports or types.

## 0.1.0
- First release: per-stack integration recipes (install, checkout metadata, sale and renewal snippets, verify step) used by `affitor onboard` and the `affitor_get_integration_plan` MCP tool.
