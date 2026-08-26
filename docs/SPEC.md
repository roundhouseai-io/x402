# x402 CLI Specification

**Version:** 0.1 draft
**Status:** For review
**Owner:** Roundhouse AI Ltd
**Date:** 26 August 2026

> This is the design contract for the tool. The implementation follows it; where it knowingly departs, the departure is recorded in [`spec-deviations.md`](spec-deviations.md) with the reason. Change this document by PR, with a `type: spec` label.

---

## 1. Purpose

A single CLI that lets any agent make x402-paid HTTP requests with one command. It handles the full payment loop (request, 402, sign, retry, response), delegates all signing to an OWS wallet, enforces spend limits, and records telemetry for every transaction.

Design goals, in priority order:

1. **One command for the whole flow.** `npx x402 <url>` should work with zero config beyond a wallet.
2. **Wallet-agnostic, no raw private keys.** Signing goes through a pluggable signer backend. OWS is the reference backend, not a dependency: any wallet that can produce an EIP-712 signature can plug in. Keys never appear in argv, env vars, or logs. This is a deliberate contrast with Coinbase's `awal`, which is x402-capable but ties the agent to Coinbase custody.
3. **Agents are the primary user.** Machine-readable output, stable exit codes, idempotent retries, and predictable failure modes matter more than pretty output.
4. **Every transaction is observable.** Local ledger always. Remote telemetry sink (IOI indexer) optional.

Non-goals for v1: non-Base chains, non-USDC assets, streaming responses, browser use.

---

## 2. Installation and invocation

```bash
npx x402 <url> [flags]          # zero-install via npx
npm i -g @roundhouseai/x402     # or global install
```

The bare form `npx x402 <url>` is sugar for `npx x402 call <url>`. If the first argument looks like a URL, `call` is assumed. This is the "very easy" path:

```bash
npx x402 https://mcpfax-utility.bowling-anthony.workers.dev/v1/lei --data.query "Amplify Limited"
```

With a default wallet configured (section 7), that one line does: GET with query param, receive 402, check price against limits, sign EIP-3009 authorization via OWS, retry with `X-PAYMENT`, print JSON body, write ledger entry.

---

## 3. Command surface

| Command                                | Purpose                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `x402 call <url>`                      | Full request + pay + retry loop (default command)                                                 |
| `x402 probe <url>`                     | Fetch 402 payment requirements only. Never pays.                                                  |
| `x402 pay <402-json>`                  | Build a signed `X-PAYMENT` header from a 402 payload. No HTTP.                                    |
| `x402 verify <receipt>`                | Confirm settlement of a prior payment                                                             |
| `x402 wallet <list\|balance\|address>` | Passthrough to OWS                                                                                |
| `x402 history [query]`                 | Query the local ledger                                                                            |
| `x402 discover <capability>`           | Query the IOI index for providers by capability, price-sorted                                     |
| `x402 serve`                           | Run the unified endpoint: a local HTTP gateway and MCP server wrapping the full flow (section 10) |
| `x402 config <get\|set\|list>`         | Manage `~/.x402/config.json`                                                                      |

---

## 4. Passing data

Three mechanisms. They can be combined; later sources override earlier on key collision. Precedence: dot flags > `--json` > stdin.

### 4.1 Dot-path flags

`--data.<path> <value>` builds a nested object. Paths use dots for objects and `[n]` for arrays.

```bash
x402 call https://api.example.com/v1/screen \
  --data.company.name "Amplify Limited" \
  --data.company.jurisdiction GB \
  --data.checks[0] sanctions \
  --data.checks[1] pep \
  --data.limit 10 \
  --data.deep true
```

Produces:

```json
{
  "company": { "name": "Amplify Limited", "jurisdiction": "GB" },
  "checks": ["sanctions", "pep"],
  "limit": 10,
  "deep": true
}
```

**Type coercion.** Values that parse as JSON scalars are coerced: `10` becomes a number, `true`/`false` booleans, `null` null. Everything else is a string. `--data-strings` disables coercion for the whole call. To force a single value to string, prefix with `str:` (`--data.postcode str:10001`).

### 4.2 JSON blob

```bash
x402 call <url> --json '{"company":{"name":"Amplify Limited"}}'
x402 call <url> --json @payload.json     # from file
cat payload.json | x402 call <url> --json -   # from stdin
```

### 4.3 Placement rules

- **GET / HEAD / DELETE:** data is flattened to query params. Nested keys use bracket notation (`company[name]=Amplify+Limited`). Override with `--body-always` to force a body.
- **POST / PUT / PATCH:** data is sent as a JSON body, `Content-Type: application/json`. Override with `--form` for `application/x-www-form-urlencoded`.
- **Method inference:** no data → GET. Any data via `--json` or dot flags → POST, unless `--method` is set or the data was routed to query params by an explicit `--method GET`.

### 4.4 Other request flags

| Flag           | Meaning                                            |
| -------------- | -------------------------------------------------- |
| `--method, -X` | HTTP method (default: inferred)                    |
| `--header, -H` | Extra header, repeatable (`-H "X-Api-Version: 2"`) |
| `--timeout`    | Total timeout in seconds (default 30)              |
| `--out <file>` | Write response body to file instead of stdout      |
| `--raw`        | Print body only, no envelope, even without a TTY   |

---

## 5. Payment flow

1. Send the request.
2. On non-402: return response, log ledger entry with `amount: 0`.
3. On 402: parse the x402 payment-required payload (scheme, asset, chain, amount, payTo, nonce window).
4. **Gate checks, in order:** payTo allowlist (if configured) → `--max` per-call cap → session `--budget` → the signer backend's own policy layer (e.g. OWS policies). First failure aborts with the matching exit code. The backend policy is the authoritative control; CLI-side caps are fail-fast conveniences.
5. Build the EIP-3009 `transferWithAuthorization` typed-data payload and request a signature from the configured signer backend for the named wallet.
6. Retry the request with the `X-PAYMENT` header.
7. Return the response and log the full ledger entry.

### 5.1 Idempotency

The signed authorization is cached at `~/.x402/authcache/` keyed by `hash(url + method + body + payTo + amount + validBefore)`. If the paid retry times out or fails at the network layer, re-running the same command **reuses the cached authorization** rather than signing a new one. Cache entries expire with the authorization's `validBefore`. This is the primary defence against double payment, which is the most likely agent failure mode.

`--no-cache` forces a fresh authorization. `--dry-run` performs steps 1-4 and prints what would be paid without signing.

### 5.2 Payment flags

| Flag                   | Meaning                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `--wallet, -w`         | Wallet name or id within the active signer backend (default: config `wallet.default`) |
| `--signer`             | Signer backend to use for this call (default: config `wallet.backend`)                |
| `--max`                | Refuse if the quoted price exceeds this (asset units, e.g. `0.01`)                    |
| `--budget`             | Cumulative cap for this process's lifetime                                            |
| `--chain`              | Restrict acceptable payment chains (default `base`)                                   |
| `--dry-run`            | Show payment requirements, do not pay                                                 |
| `--receipt-out <file>` | Write the payment receipt JSON to a file                                              |

### 5.3 Signer backends (wallet-agnostic by design)

The payment engine never touches key material. It talks to a **signer backend** through a minimal interface:

```
getAccounts()                      -> [{ id, address, chains[] }]
getAddress(walletId, chain)        -> address
signTypedData(walletId, payload)   -> signature      // EIP-712, required
capabilities()                     -> { typedData: true, policies: bool, ... }
```

Anything that implements this can be the wallet. The CLI ships with:

| Backend | What it is                                                                                                                              | Status          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `ows`   | Open Wallet Standard agent access layer: API-key auth, policy-gated signing                                                             | Default, v1     |
| `local` | Encrypted keystore file (scrypt + AES-GCM), passphrase from env or prompt. Development and CI only; prints a warning on every signature | v1              |
| `exec`  | External signer protocol: any executable speaking JSON over stdio, in the style of git credential helpers                               | v1              |
| `awal`  | Adapter over Coinbase's Agentic Wallet CLI for teams already on it                                                                      | Candidate, v1.1 |

The `exec` protocol is the escape hatch that keeps this genuinely agnostic: a hardware wallet bridge, an MPC service, a KMS wrapper, or a bespoke corporate signer is one small executable away, in any language, with no changes to the CLI. Third parties can also publish npm packages named `x402-signer-<name>` which the CLI auto-discovers.

Rules for all backends:

1. The interface is signature-only. Backends never receive HTTP request or response data, only the EIP-712 payload, so a malicious or buggy backend cannot exfiltrate call content.
2. A backend that cannot do EIP-712 typed-data signing cannot be used for the x402 `exact` scheme, and the CLI fails at config time (exit 47), not at payment time.
3. Backends may enforce their own policies and refuse to sign; refusal maps to exit 42.
4. Backend choice is per-call (`--signer`), per-project (`.x402rc`), or global (config). Ledger records include the backend name.

---

## 6. Telemetry

Two layers: a local ledger that is always on, and an optional remote sink.

### 6.1 Local ledger

Append-only JSONL at `~/.x402/ledger.jsonl`. One record per call (paid or not):

```json
{
  "id": "01J8ZK3M9Q...",
  "ts": "2026-08-26T13:43:02.114Z",
  "url": "https://mcpfax-utility.bowling-anthony.workers.dev/v1/lei",
  "method": "GET",
  "wallet": "my-agent",
  "request": {
    "dataHash": "sha256:9f2c...",
    "dataKeys": ["query"],
    "headersHash": "sha256:aa01...",
    "bytes": 214
  },
  "payment": {
    "paid": true,
    "amount": "0.002",
    "asset": "usdc",
    "chain": "eip155:8453",
    "payTo": "0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd",
    "scheme": "exact",
    "authHash": "sha256:bc44...",
    "cacheHit": false
  },
  "response": {
    "status": 200,
    "bodyHash": "sha256:77de...",
    "bytes": 1832,
    "latencyMs": 412,
    "paymentLatencyMs": 196
  },
  "exitCode": 0,
  "agent": { "session": "env:X402_SESSION", "tag": "env:X402_AGENT" }
}
```

### 6.2 Payload capture levels

The record above is level `hash`, the default. Controlled by `--telemetry-payload` or config `telemetry.payload`:

| Level  | Request/response bodies stored as              |
| ------ | ---------------------------------------------- |
| `none` | Not recorded at all (byte counts only)         |
| `hash` | SHA-256 + key names + byte count (**default**) |
| `full` | Complete plaintext bodies                      |

**Default is `hash`, deliberately.** Agents will pass names, company data, and eventually personal data through this tool. A default-on plaintext log of every payload is a data-protection liability and a second copy of sensitive data to secure. `full` exists for debugging and for endpoints you control; turn it on per-call, not globally. `telemetry.redactKeys` (config, list of dot paths) masks specific keys even at `full` level.

Auth-like request headers (`Authorization`, `X-Api-Key`, `Cookie`, `X-PAYMENT`) are always redacted at every level. Only their presence is recorded.

### 6.3 Remote sink

Off by default. When configured, ledger records are batched (max 50 records or 10s) and POSTed to the sink, itself authenticated via a static bearer token from config. Intended target: the IOI indexer ingest endpoint, which turns fleet-wide payment telemetry into pricing and liveness data for `x402 discover`.

```json
"telemetry": {
  "payload": "hash",
  "sink": {
    "url": "https://ioi.md/ingest/v1/x402",
    "token": "env:IOI_INGEST_TOKEN",
    "enabled": true
  }
}
```

Sink failures never fail the call. Records queue locally (`~/.x402/outbox/`) and flush on the next invocation.

### 6.4 History queries

```bash
x402 history --since 24h --paid-only --json
x402 history --sum                     # total spend by asset
x402 history --by payTo --sum          # spend grouped by recipient
```

---

## 7. Configuration

`~/.x402/config.json`, overridable per-project by `.x402rc` in the working directory, overridable by flags. `env:` prefixed values are resolved from the environment at runtime.

```json
{
  "wallet": {
    "backend": "ows",
    "default": "my-agent",
    "backends": {
      "ows": { "endpoint": "http://127.0.0.1:8402", "apiKey": "env:OWS_API_KEY" },
      "local": { "keystore": "~/.x402/keystore.json", "passphrase": "env:X402_KEYSTORE_PASS" },
      "exec": { "command": "/usr/local/bin/my-signer" }
    }
  },
  "limits": { "maxPerCall": "0.05", "dailyCap": "5.00" },
  "allowlist": { "payTo": [], "domains": [] },
  "telemetry": { "payload": "hash", "sink": { "enabled": false } },
  "defaults": { "chain": "base", "timeout": 30 }
}
```

Empty allowlists mean allow-all. `limits.dailyCap` is enforced CLI-side from the ledger **and** should be mirrored in the signer backend's policy layer where one exists; the CLI check is advisory, the backend policy is binding. Backends without a policy layer (e.g. `local`) have only the CLI-side caps, which is one reason `local` is dev-only.

---

## 8. Output and exit codes

With a TTY, human-readable output. Without one (the agent case), a JSON envelope on stdout:

```json
{
  "ok": true,
  "status": 200,
  "paid": true,
  "amount": "0.002",
  "asset": "usdc",
  "receiptId": "01J8ZK3M9Q...",
  "body": {}
}
```

`--raw` prints the response body alone.

| Code | Meaning                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------- |
| 0    | Success (paid or free)                                                                                   |
| 1    | Generic / network error                                                                                  |
| 40   | Invalid 402 payload (endpoint not x402-compliant)                                                        |
| 42   | Denied by signer backend policy                                                                          |
| 43   | Denied by payTo/domain allowlist                                                                         |
| 44   | Price exceeds `--max`                                                                                    |
| 45   | Session budget or daily cap exhausted                                                                    |
| 46   | Insufficient wallet balance                                                                              |
| 47   | Signer backend unreachable, auth failed, or lacks typed-data capability                                  |
| 50   | Payment sent, but no valid response returned (receipt logged, investigate before retrying without cache) |

Agents branch on exit codes; the codes are a stability contract from v1.

---

## 9. Security requirements

1. **No raw key flags.** There is no `--private-key`. Development keys live only in the `local` backend's encrypted keystore; the keystore refuses to load if the file is world-readable, and every `local` signature prints a warning to stderr.
2. All signing via a signer backend's `signTypedData` (section 5.3). The CLI holds a backend credential (e.g. an OWS API key) scoped to the named wallet, never key material. Backends receive only the EIP-712 payload, never request or response data.
3. Auth headers redacted from all telemetry, all levels.
4. Ledger, authcache, and keystore files created `0600`.
5. The CLI never escalates: if the backend denies or lacks the capability, the call fails. No fallback signing path, and no automatic fallback from one backend to another.

---

## 10. Unified endpoint (`x402 serve`)

Not every agent can shell out to a CLI. Browser-based agents, hosted workflows, and MCP-native clients need the same capability over plain HTTP or as an MCP tool. `x402 serve` runs the CLI's engine as a long-lived local service exposing one unified surface. Same wallet integration, same gates, same ledger; one process, many callers.

```bash
x402 serve                    # HTTP on 127.0.0.1:8403
x402 serve --mcp              # additionally expose an MCP server (stdio or SSE)
```

### 10.1 HTTP API

All routes require `Authorization: Bearer <caller-token>` (section 10.4).

**`POST /v1/call`** - the whole payment loop in one request:

```json
{
  "url": "https://mcpfax-utility.bowling-anthony.workers.dev/v1/lei",
  "method": "GET",
  "data": { "query": "Amplify Limited" },
  "max": "0.01",
  "wallet": "my-agent"
}
```

Response is the same JSON envelope as the CLI (section 8): `ok`, `status`, `paid`, `amount`, `receiptId`, `body`. Errors carry the CLI exit code in an `errorCode` field, so the same failure taxonomy holds across both surfaces.

**`POST /v1/probe`** - `{ "url": ... }`, returns parsed 402 requirements, never pays.

**`GET /v1/discover?capability=lei`** - proxies `x402 discover`.

**`GET /v1/history`** - ledger queries, filtered to the calling token's own records unless the token has the `admin` scope.

**`GET /v1/health`** - signer backend reachability, wallet balance summary, outbox depth.

### 10.2 Capability addressing

`/v1/call` and the CLI both accept a capability URI in place of a URL:

```json
{ "url": "x402:lei", "data": { "query": "Amplify Limited" } }
```

Resolution: query the IOI index for live providers of that capability, filter by allowlist, pick the cheapest, call it. The resolved provider and its price appear in the response envelope and the ledger record. `pin` in config maps a capability to a fixed provider when determinism matters more than price:

```json
"pins": { "lei": "https://mcpfax-utility.bowling-anthony.workers.dev/v1/lei" }
```

This is the piece that makes Roundhouse skills provider-agnostic: a skill says "do an LEI lookup", not "call this vendor's URL", and pricing pressure stays on the providers.

### 10.3 MCP server

With `--mcp`, the same engine is exposed as MCP tools: `x402_call`, `x402_probe`, `x402_discover`, `x402_history`. Tool schemas mirror the HTTP bodies. This makes every x402 provider on the index reachable from any MCP client with zero per-provider integration, which is the unified part: one tool, every paid API.

### 10.4 Caller tokens and per-caller budgets

The unified endpoint is a spend-authorized proxy. Anything that can reach it can spend from the wallet, so treat it like a hot wallet API even on localhost:

- Binds to `127.0.0.1` by default. `--host 0.0.0.0` requires `--i-understand-this-exposes-spending` and TLS config, and is still discouraged; put real network exposure behind your own gateway.
- Callers authenticate with tokens minted via `x402 serve token create <name> --budget-daily 1.00 --max-per-call 0.01 [--capabilities lei,kyb] [--admin]`. Tokens are stored hashed.
- Per-token budgets are enforced by the server from the ledger, on top of (not instead of) the global caps and any signer backend policy layer. Ledger records carry the token name in the `agent` block, so `x402 history --by agent --sum` gives per-agent spend.
- Token limits fail with the same exit-code taxonomy (`45` budget exhausted, `44` over per-call max) surfaced as `errorCode`.

### 10.5 Concurrency and idempotency

The server serialises signing per wallet and shares the CLI's authorization cache, so two callers requesting the identical call concurrently produce one authorization, not two. Callers may supply an `Idempotency-Key` header; replays within the authorization validity window return the original receipt and cached response envelope (response bodies are replayable only when telemetry payload level is `full`; otherwise the replay returns the receipt with `bodyReplay: false`).

---

## 11. SKILL.md (agent onboarding)

Ship a `SKILL.md` with the package documenting exactly three flows: `probe` (what does this cost?), `call` (get the data), `discover` (who sells this cheapest?), each with one copy-pasteable example for both surfaces (CLI and unified endpoint) plus the shared exit-code table. One binary, one endpoint, one skill file, stable error codes is the contract that makes every Roundhouse skill x402-capable without per-agent integration work.

---

## 12. Open questions (blocking v1)

1. **Does OWS expose EIP-712 typed-data signing?** The published core types show `signMessage` with `utf8`/`hex` encodings only. EIP-3009 requires typed-data signing. The signer abstraction (5.3) means this no longer blocks the CLI itself (the `local` backend can ship first), but OWS as the flagship backend needs it; raise upstream early.
2. **402 payload variance.** How strictly do live providers follow the x402 spec? `probe` should be run against the current IOI index to size the compatibility shim needed in the 402 parser.
3. **Receipt verification.** Facilitator settlement confirmation vs direct on-chain lookup for `verify`. Facilitator is simpler; on-chain is trustless. Proposal: facilitator in v1, on-chain in v1.1.
4. **Multi-option 402s.** When a provider offers several payment options (chains/assets), selection order is: config `defaults.chain`, then cheapest. Confirm this is the right tiebreak.
5. **Serve scope for v1.** Shipping CLI + serve + MCP together is three surfaces to stabilise at once. Proposal: v1 ships CLI and `serve` HTTP with token budgets; MCP mode and capability pinning land in v1.1 unless an agent fleet needs MCP on day one.
6. **Prior art on the signer abstraction.** Solana Foundation's `pay` already describes a model where the CLI prepares the payment and asks a local "wallet backend" to authorize the signature. Review its backend interface before finalising 5.3: adopting or staying compatible with an existing signer protocol is better than inventing a fourth one, and contributing an OWS backend to `pay` remains a live alternative to building the whole CLI.
7. **`exec` signer protocol spec.** The JSON-over-stdio protocol needs its own one-page spec (framing, timeout, error mapping, version negotiation) before third parties can build against it.
