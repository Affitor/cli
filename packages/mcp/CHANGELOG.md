# Changelog — @affitor/mcp

## 0.2.1
- `affitor_track_sale` and `affitor_track_refund` are only registered when `AFFITOR_MCP_WRITE=1`. Without it the server offers 5 tools, none of which can create a sale or reverse a commission. **If you call `affitor_track_sale` from an agent today, add `AFFITOR_MCP_WRITE=1` to the server's `env`.**
- Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`); the two money tools are marked destructive.
- `testMode` on `affitor_track_sale` records an `is_test` sale with no commission; on `affitor_track_lead` it records a test lead; on `affitor_track_refund` it is a dry run that calls nothing.
- README: onboard, MCP tools and recipes documentation backfilled after 0.2.0.

## 0.2.0
- First public release: 7 tools over stdio.
