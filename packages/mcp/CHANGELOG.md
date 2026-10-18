# Changelog — @affitor/mcp

## 0.2.3 (registry 0.2.4)
- Tool and input descriptions rewritten: each tool says when to use it and what it returns; each input says what it means, where the value comes from, an example and what leaving it out does. No change to tools, schemas or behaviour.
- A full refund leaves `refundAmountCents` out; sending 0 is refused for newer sales.

## Registry 0.2.3 (server.json only; the npm package stays 0.2.2)
- The registry entry `com.affitor/mcp` adds the hosted server as a remote: `https://mcp.affitor.com/mcp` (streamable HTTP, sign in with your Affitor account, read-only). Description and website point at the MCP docs.

## 0.2.2
- Listed in the Official MCP Registry as `com.affitor/mcp`: `mcpName` in package.json and a `server.json` (npm, stdio, the three environment variables). No change to tools or behaviour.

## 0.2.1
- `affitor_track_sale` and `affitor_track_refund` are only registered when `AFFITOR_MCP_WRITE=1`. Without it the server offers 5 tools, none of which can create a sale or reverse a commission. **If you call `affitor_track_sale` from an agent today, add `AFFITOR_MCP_WRITE=1` to the server's `env`.**
- Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`); the two money tools are marked destructive.
- `testMode` on `affitor_track_sale` records an `is_test` sale with no commission, under the transaction id `test_<invoiceId>` so it never blocks the real sale with the same invoice; on `affitor_track_lead` it records a test lead; on `affitor_track_refund` it is a dry run that calls nothing.
- `invoiceId` must not be empty on `affitor_track_sale` and `affitor_track_refund`; `affitor_readiness` is marked `openWorldHint` because the check fetches the brand's site.
- README: onboard, MCP tools and recipes documentation backfilled after 0.2.0.

## 0.2.0
- First public release: 7 tools over stdio.
