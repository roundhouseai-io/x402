---
'@roundhouseai/x402': minor
---

Point capability discovery at the Roundhouse index.

- `discover.indexUrl` now defaults to `https://www.roundhouse.studio/api/v0`, queried as `GET <indexUrl>/endpoints?q=<capability>`. The index's `endpoints` payload is mapped onto providers (`resource` → url, `service_name` → capability, `price_usdc` → price with `asset: "USDC"`, `pay_to` → payTo, `is_live`, `http_status`, `l30_unique_payers`); the previous `providers`/`results`/bare-array and camelCase shapes are still read.
- Providers sort live-first, then cheapest. `x402 discover` marks a down provider `[down]`; resolving `x402:<capability>` for a call skips down providers entirely rather than routing a payment to an endpoint the index last saw unreachable, and says how many allowed providers are down when none can be used.
- The telemetry sink example and its bearer token are `https://www.roundhouse.studio/api/v0/ingest/x402` and `ROUNDHOUSE_INGEST_TOKEN`.
