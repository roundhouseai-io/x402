# @roundhouseai/x402

## 0.1.0

### Minor Changes

- 6816490: First release. One command for the whole x402 payment loop.

  - Signing goes through a pluggable **signer backend**, so the tool is wallet-agnostic: `ows` (the reference backend, API-key auth and policy-gated signing), `local` (an encrypted scrypt + AES-256-GCM keystore, development and CI only, warning on every signature), `exec` (any executable speaking JSON over stdio), and third-party backends auto-discovered as `x402-signer-<name>`. A backend receives one EIP-712 payload and nothing else, and one that cannot sign typed data fails when the signer is resolved rather than mid-payment.
  - `call` runs the full loop: request, 402, spend gates, EIP-3009 authorization signed via OWS, retry with `X-PAYMENT`, receipt. `probe` reports the price without paying; `pay` builds a header from a 402 payload; `verify` confirms settlement; `wallet`, `history`, `discover` and `config` round out the surface.
  - Dot-path data flags (`--data.company.name`), `--json` (inline, `@file` or stdin), type coercion with `str:` and `--data-strings`, and the GET-to-query-params placement rules.
  - Spend gates in a fixed order — domain and payTo allowlists, `--max`, `--budget`, `limits.dailyCap` — each with its own stable exit code, all checked before anything is signed.
  - Signed authorizations are cached and reused, so a retry after a lost response does not pay twice.
  - An append-only local ledger with `none`/`hash`/`full` payload levels (`hash` by default), always-redacted auth headers, and an optional batched remote sink with a local outbox.
  - `serve` exposes the same engine over HTTP with hashed caller tokens, per-token daily and per-call budgets, capability scoping and `Idempotency-Key` replay; `serve --mcp` exposes it as four MCP tools.
  - `x402 signer list|check` inspects backends and their capabilities; `x402 signer keystore add|list` manages the development keystore.
  - Stable exit codes (0, 1, 40, 42–47, 50) surfaced identically on the CLI, HTTP and MCP surfaces.

- 2809146: Point capability discovery at the Roundhouse index.

  - `discover.indexUrl` now defaults to `https://www.roundhouse.studio/api/v0`, queried as `GET <indexUrl>/endpoints?q=<capability>`. The index's `endpoints` payload is mapped onto providers (`resource` → url, `service_name` → capability, `price_usdc` → price, `pay_to` → payTo, `l30_total_calls` → calls30d, `l30_unique_payers` → payers30d, `is_live` → live); the previous `providers`/`results`/bare-array and camelCase shapes are still read.
  - The index states the chain as CAIP-2 (`eip155:8453`) and the asset as a contract address. Both are resolved through `core/assets.ts` to the names the 402 parser already produces (`base`, `usdc`), so `defaults.chain` and the allowlists compare like with like; an unrecognised network or asset passes through verbatim.
  - Providers sort live-first, then cheapest. `x402 discover` marks a down provider `[down]`; resolving `x402:<capability>` for a call skips down providers entirely rather than routing a payment to an endpoint the index last saw unreachable, and says how many allowed providers are down when none can be used.
  - The telemetry sink example and its bearer token are `https://www.roundhouse.studio/api/v0/ingest/x402` and `ROUNDHOUSE_INGEST_TOKEN`.
  - `x402 discover`, `GET /v1/discover` and the `x402_discover` MCP tool now report the capability's whole market, not just a list: `stats` carries `min`, `p25`, `median`, `p75`, `max`, `spread` (max / min) and `spot` (the average actually paid, call-weighted), plus offer/provider/live counts and the pricing `unit`. Discovery asks `unified.json?capability=<slug>` first because it is the only surface carrying them, and falls back to the `/endpoints?q=` keyword search — with `stats: null` — for anything it does not recognise. The new URL is the `discover.unifiedUrl` config key.
  - Providers gain `lastCalledAt`, `confidence` and `gateway` from the same document.
  - **The 402 parser reads x402 v2 headers.** v2 providers put the requirements in `Payment-Required` or `WWW-Authenticate: X402 requirements="…"`, base64-encoded, and leave a human-readable stub in the body. Previously every such endpoint failed with exit 40 (`unsupported or missing network in 402 payload: null`) — including BlockRun.AI and Otto AI, two of the most-used endpoints on the index. The header is now read first and treated as authoritative, since the body's price can be stale: BlockRun's body says `0.01` where its header says `0.011`.
