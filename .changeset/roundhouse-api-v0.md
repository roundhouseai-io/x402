---
'@roundhouseai/x402': minor
---

Point discovery at the current Roundhouse API, and stop presenting a capped offer list as the whole market.

- **New defaults.** `discover.indexUrl` is `https://api.roundhouseai.io/v0` and `discover.unifiedUrl` is `https://api.roundhouseai.io/v0/unified`. The capability document now takes the slug as a path segment (`/v0/unified/web-search`) rather than a query parameter, and answers `404` with a plain-text body for a slug it does not know — which the `/endpoints` fallback already handled.
- **The pricing block moved.** The current document carries it at the top level with `spot_basis`; the retired `unified.json` nested it under `stats.price` with `spotBasis`. Both are read, and a `discover.unifiedUrl` still ending in `.json` is queried in the old form, so a pinned config degrades to nothing rather than to a stats-less market.
- **`truncated` on every discovery surface** — CLI, HTTP and MCP. The index returns at most 50 offers per capability while `stats` describe every offer there is, so the cheapest listed is the cheapest that came back, not the cheapest that exists. It is derived from the counts rather than the document's own flag, which reads `false` on a capability that plainly capped the list (50 offers returned, `stats.offers: 137`).
- **`stats.priced` / `stats.unpriced`**, so a caller can see how much of the market the quantiles actually describe.
- The `/endpoints` keyword fallback now asks for an explicit `limit` instead of taking the API's default of 100.
