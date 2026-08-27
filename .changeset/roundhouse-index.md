---
'@roundhouseai/x402': minor
---

Point capability discovery at the Roundhouse index.

- `discover.indexUrl` now defaults to `https://www.roundhouse.studio/api/v0`, queried as `GET <indexUrl>/endpoints?q=<capability>`. The index's `endpoints` payload is mapped onto providers (`resource` → url, `service_name` → capability, `price_usdc` → price, `pay_to` → payTo, `l30_total_calls` → calls30d, `l30_unique_payers` → payers30d, `is_live` → live); the previous `providers`/`results`/bare-array and camelCase shapes are still read.
- The index states the chain as CAIP-2 (`eip155:8453`) and the asset as a contract address. Both are resolved through `core/assets.ts` to the names the 402 parser already produces (`base`, `usdc`), so `defaults.chain` and the allowlists compare like with like; an unrecognised network or asset passes through verbatim.
- Providers sort live-first, then cheapest. `x402 discover` marks a down provider `[down]`; resolving `x402:<capability>` for a call skips down providers entirely rather than routing a payment to an endpoint the index last saw unreachable, and says how many allowed providers are down when none can be used.
- The telemetry sink example and its bearer token are `https://www.roundhouse.studio/api/v0/ingest/x402` and `ROUNDHOUSE_INGEST_TOKEN`.
- `x402 discover`, `GET /v1/discover` and the `x402_discover` MCP tool now report the capability's whole market, not just a list: `stats` carries `min`, `p25`, `median`, `p75`, `max`, `spread` (max / min) and `spot` (the average actually paid, call-weighted), plus offer/provider/live counts and the pricing `unit`. Discovery asks `unified.json?capability=<slug>` first because it is the only surface carrying them, and falls back to the `/endpoints?q=` keyword search — with `stats: null` — for anything it does not recognise. The new URL is the `discover.unifiedUrl` config key.
- Providers gain `lastCalledAt`, `confidence` and `gateway` from the same document.
- **The 402 parser reads x402 v2 headers.** v2 providers put the requirements in `Payment-Required` or `WWW-Authenticate: X402 requirements="…"`, base64-encoded, and leave a human-readable stub in the body. Previously every such endpoint failed with exit 40 (`unsupported or missing network in 402 payload: null`) — including BlockRun.AI and Otto AI, two of the most-used endpoints on the index. The header is now read first and treated as authoritative, since the body's price can be stale: BlockRun's body says `0.01` where its header says `0.011`.
