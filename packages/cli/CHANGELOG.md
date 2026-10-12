# Changelog — affitor (CLI)

## 0.4.2
- Security: the secrets file is written with owner-only permissions, and login URLs are opened safely (#26).
- API key rotation: warnings for a key that must be replaced, a clear error for a retired key, and the `Deprecation`/`Sunset`/`Link` headers are read so a retired key is never silent (#27, #30). A refused key points to Regenerate, not to `affitor init` (#28).
- Exit codes: `affitor onboard` exits 0 only when the integration is verified; `affitor whoami --json` exits 1 when logged out, like the human output (#29).
- Docs links point at affitor.com/docs (#32).

## 0.4.1
- Published 2026-06-15.
