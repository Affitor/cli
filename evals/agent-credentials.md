# Per-client agent credential regression

Run on Node 20+ after building all workspaces:

```sh
npm exec --workspace packages/cli -- vitest run tests/program-agent-client.test.ts tests/agent-setup.test.ts
```

Fixtures use a local fake CMS, synthetic sessions/keys and isolated directories.
They verify separate client keys, owner-session lifecycle headers, idempotent
reuse across pagination, revoked-row replacement, application-key preservation,
partial mint/local-write failure compensation, unknown mint outcomes without
retry, tracked/unsafe/private-file conflicts, concurrent private-file retention,
static doctor and actual generated launcher credential selection. Dry-run,
no-consent and missing-login calls must mint nothing and write nothing. No keys
or session tokens may appear in command output/config. A successful installation
must report an unverified next step and must make no readiness/status call.

Real Windows CI additionally runs `tests/agent-setup-windows.test.ts` against
cmd.exe and the generated standalone launcher, including a selected private key
with an inherited live key and mixed-case URL override.
