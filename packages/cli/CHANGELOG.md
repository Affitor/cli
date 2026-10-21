# Changelog — affitor (CLI)

## Unreleased
- `affitor agent setup --client <name> --code <code>`: install an agent with the one-time setup code from the dashboard (Setup, Tracking, With AI), no `affitor login` needed. The code works once and for 10 minutes; the key it makes can also write a settings draft.
- `affitor draft show` and `affitor draft set --name … --website … --type recurring --rate 20 --months 12` (or `--file draft.json`): the agent proposes business details and the commission; nothing changes until an owner or admin applies the draft in the dashboard. Only for programs that are not live yet.

## 0.4.4
- `affitor init` writes the program's partner link parameter to `ref_param` (`via` for programs created from now on, `aff` for older ones), from the server's answer. An older server without that field still gives `aff`. The setup notes say which parameter partner links use; the tracker reads both `?aff=` and `?via=`.

## 0.4.3
- `affitor setup stripe` now points to the dashboard (program Settings, Connect Stripe) and exits 1 (`{"error": "stripe_setup_moved"}` with `--json`). The old flow could not complete: its token exchange needed Affitor's platform secret, the API that saved the connection is retired (410), and the webhook it created pointed at a URL the API does not serve. It no longer creates anything on your Stripe account. The unused `stripe` dependency is removed.

## 0.4.2
- Security: the secrets file is written with owner-only permissions, and login URLs are opened safely (#26).
- API key rotation: warnings for a key that must be replaced, a clear error for a retired key, and the `Deprecation`/`Sunset`/`Link` headers are read so a retired key is never silent (#27, #30). A refused key points to Regenerate, not to `affitor init` (#28).
- Exit codes: `affitor onboard` exits 0 only when the integration is verified; `affitor whoami --json` exits 1 when logged out, like the human output (#29).
- Docs links point at affitor.com/docs (#32).

## 0.4.1
- Published 2026-06-15.
