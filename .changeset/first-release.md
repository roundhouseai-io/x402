---
'@roundhouseai/x402': minor
---

First release. One command for the whole x402 payment loop.

- Signing goes through a pluggable **signer backend**, so the tool is wallet-agnostic: `ows` (the reference backend, API-key auth and policy-gated signing), `local` (an encrypted scrypt + AES-256-GCM keystore, development and CI only, warning on every signature), `exec` (any executable speaking JSON over stdio), and third-party backends auto-discovered as `x402-signer-<name>`. A backend receives one EIP-712 payload and nothing else, and one that cannot sign typed data fails when the signer is resolved rather than mid-payment.
- `call` runs the full loop: request, 402, spend gates, EIP-3009 authorization signed via OWS, retry with `X-PAYMENT`, receipt. `probe` reports the price without paying; `pay` builds a header from a 402 payload; `verify` confirms settlement; `wallet`, `history`, `discover` and `config` round out the surface.
- Dot-path data flags (`--data.company.name`), `--json` (inline, `@file` or stdin), type coercion with `str:` and `--data-strings`, and the GET-to-query-params placement rules.
- Spend gates in a fixed order — domain and payTo allowlists, `--max`, `--budget`, `limits.dailyCap` — each with its own stable exit code, all checked before anything is signed.
- Signed authorizations are cached and reused, so a retry after a lost response does not pay twice.
- An append-only local ledger with `none`/`hash`/`full` payload levels (`hash` by default), always-redacted auth headers, and an optional batched remote sink with a local outbox.
- `serve` exposes the same engine over HTTP with hashed caller tokens, per-token daily and per-call budgets, capability scoping and `Idempotency-Key` replay; `serve --mcp` exposes it as four MCP tools.
- `x402 signer list|check` inspects backends and their capabilities; `x402 signer keystore add|list` manages the development keystore.
- Stable exit codes (0, 1, 40, 42–47, 50) surfaced identically on the CLI, HTTP and MCP surfaces.
