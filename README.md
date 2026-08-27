# x402

**One command for the whole x402 payment loop.** Request, 402, sign, retry, receipt — with spend limits, a local ledger, and no private keys anywhere near your shell.

[![CI](https://github.com/roundhouseai-io/x402/actions/workflows/ci.yml/badge.svg)](https://github.com/roundhouseai-io/x402/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@roundhouseai/x402.svg)](https://www.npmjs.com/package/@roundhouseai/x402)
[![node](https://img.shields.io/node/v/@roundhouseai/x402.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

```bash
npx @roundhouseai/x402 https://api.example.com/v1/lei --data.query "Roundhouse AI Ltd."
```

With a wallet configured, that one line does: GET with a query param → receives 402 → checks the price against your limits → signs an EIP-3009 authorization via your OWS wallet → retries with `X-PAYMENT` → prints the JSON body → writes a ledger entry.

> **On `npx x402`** — the unscoped `x402` name on npm belongs to another project, so the zero-install form is `npx @roundhouseai/x402`. A global install (`npm i -g @roundhouseai/x402`) gives you the short `x402` command.

## Why

Paying for an HTTP call from an agent normally means gluing together a 402 parser, an EVM signer, a nonce policy, a spend cap and an audit log — and then hoping the agent does not pay twice. This does all of that in one command, with:

- **Wallet-agnostic, no raw private keys.** Signing goes through a pluggable backend — [OWS](https://github.com/open-wallet-standard) is the reference, not a dependency, and any wallet that can produce an EIP-712 signature plugs in. Keys never appear in argv, env vars, or logs.
- **Idempotent retries.** Signed authorizations are cached and reused, so a timed-out retry does not become a second payment.
- **Spend limits that fail fast.** Per-call, per-session and per-day caps, plus payTo and domain allowlists, all checked before anything is signed.
- **Every call observable.** An append-only local ledger, always on, hashed by default. Optional remote sink for fleet telemetry.
- **Stable exit codes.** `44` is always "over your `--max`". Agents can branch on failure without parsing prose.
- **Zero runtime dependencies.** It is a payments tool; the supply-chain surface is the attack surface.

## Install

```bash
npm i -g @roundhouseai/x402      # then: x402 <url>
npx @roundhouseai/x402 <url>     # or zero-install
```

Node 20.10+ is required. Then point it at a wallet:

```bash
x402 config set wallet.backend ows
x402 config set wallet.backends.ows.endpoint http://127.0.0.1:8402
x402 config set wallet.backends.ows.apiKey env:OWS_API_KEY   # an indirection, never the secret
x402 config set wallet.default my-agent
x402 config set limits.maxPerCall 0.05
x402 signer check     # does this backend do what x402 needs?
x402 wallet list
```

## The three flows

**What does this cost?** `probe` never pays.

```bash
x402 probe https://api.example.com/v1/lei
# {"ok":true,"status":402,"paymentRequired":true,
#  "selected":{"amount":"0.002","asset":"usdc","network":"base","payTo":"0x1831…"}}
```

**Get the data.** `call` pays if a price is quoted and your gates allow it.

```bash
x402 call https://api.example.com/v1/lei --data.query "Roundhouse AI Ltd." --max 0.01
# {"ok":true,"status":200,"paid":true,"amount":"0.002","asset":"usdc",
#  "receiptId":"01J8ZK…","body":{"lei":"213800…"}}
```

**Who sells this cheapest?** `discover` asks the Roundhouse index (`https://www.roundhouse.studio/api/v0`).

```bash
x402 discover lei                                      # live providers first, cheapest first
x402 call x402:lei --data.query "Roundhouse AI Ltd."   # resolve, then call the cheapest live allowed provider
```

## Commands

| Command                                | Purpose                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| `x402 call <url>`                      | Full request + pay + retry loop (the default command)          |
| `x402 probe <url>`                     | Fetch 402 payment requirements only. Never pays.               |
| `x402 pay <402-json>`                  | Build a signed `X-PAYMENT` header from a 402 payload. No HTTP. |
| `x402 verify <receipt>`                | Confirm settlement of a prior payment                          |
| `x402 wallet <list\|balance\|address>` | Passthrough to OWS                                             |
| `x402 history [query]`                 | Query the local ledger                                         |
| `x402 discover <capability>`           | Providers for a capability, price-sorted                       |
| `x402 serve`                           | Run the unified local endpoint (HTTP, plus MCP with `--mcp`)   |
| `x402 config <get\|set\|list>`         | Manage `~/.x402/config.json`                                   |

`x402 <url>` is sugar for `x402 call <url>`.

## Passing data

Three mechanisms, combinable. Later sources win on key collision: **dot flags > `--json` > stdin**.

```bash
x402 call https://api.example.com/v1/screen \
  --data.company.name "Roundhouse AI Ltd." \
  --data.company.jurisdiction SG \
  --data.checks[0] sanctions \
  --data.checks[1] pep \
  --data.limit 10 \
  --data.deep true
```

```json
{
  "company": { "name": "Roundhouse AI Ltd.", "jurisdiction": "SG" },
  "checks": ["sanctions", "pep"],
  "limit": 10,
  "deep": true
}
```

Values that parse as JSON scalars are coerced (`10` → number, `true` → boolean, `null` → null). `--data-strings` disables coercion for the whole call; `str:` forces one value (`--data.postcode str:10001`). Leading-zero and precision-losing numbers stay strings, so ids survive intact.

```bash
x402 call <url> --json '{"company":{"name":"Roundhouse AI Ltd."}}'
x402 call <url> --json @payload.json
cat payload.json | x402 call <url> --json -
```

**Placement.** GET/HEAD/DELETE flatten data to query params with bracket notation (`company[name]=Roundhouse+AI+Ltd.`); `--body-always` overrides. POST/PUT/PATCH send a JSON body; `--form` switches to `x-www-form-urlencoded`. No data → GET; any data → POST unless `--method` says otherwise.

## Spend controls

Checked in this order, before anything is signed:

1. **Domain and payTo allowlists** (`allowlist.domains`, `allowlist.payTo`; empty means allow-all) → exit `43`
2. **`--max`** per-call cap → exit `44`
3. **`--budget`** for this process → exit `45`
4. **`limits.dailyCap`**, computed from the ledger → exit `45`
5. **The signer backend's policy layer**, the authoritative control → exit `42`

The CLI-side checks are fail-fast conveniences. The backend policy is binding; mirror your caps there too.

```bash
x402 call https://api.example.com/v1/lei --max 0.01 --budget 0.50 --dry-run
```

`--dry-run` runs everything up to and including the gates, prints what would be paid, and stops before signing.

## Idempotency

The signed authorization is cached at `~/.x402/authcache/`, keyed by the request identity (url, method, body, payTo, amount, asset, chain, wallet). If the paid retry times out or dies at the network layer, re-running the same command **reuses the cached authorization** instead of signing a new one. Entries expire at the authorization's own `validBefore`.

```bash
x402 call https://api.example.com/v1/lei          # times out after paying → exit 50
x402 call https://api.example.com/v1/lei          # reuses the authorization, cacheHit: true
x402 call https://api.example.com/v1/lei --no-cache   # deliberate fresh signature
```

Double payment is the most likely agent failure mode; see [`docs/idempotency.md`](docs/idempotency.md) for the details and the one deliberate departure from the spec.

## Output and exit codes

On a TTY you get a human summary. Without one — the agent case — stdout is a single JSON envelope:

```json
{
  "ok": true,
  "status": 200,
  "paid": true,
  "amount": "0.002",
  "asset": "usdc",
  "receiptId": "01J8ZK3M9Q…",
  "body": {}
}
```

`--raw` prints the response body alone. `--out <file>` writes the body to a file.

| Code | Meaning                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 0    | Success (paid or free)                                                                                       |
| 1    | Generic / network error                                                                                      |
| 40   | Invalid 402 payload (endpoint not x402-compliant)                                                            |
| 42   | Denied by OWS policy                                                                                         |
| 43   | Denied by payTo/domain allowlist                                                                             |
| 44   | Price exceeds `--max`                                                                                        |
| 45   | Session budget or daily cap exhausted                                                                        |
| 46   | Insufficient wallet balance                                                                                  |
| 47   | OWS unreachable or auth failed                                                                               |
| 50   | Payment sent, but no valid response returned (receipt logged; investigate before retrying with `--no-cache`) |

These are a stability contract from v1. See [`docs/exit-codes.md`](docs/exit-codes.md).

## Telemetry

An append-only local ledger at `~/.x402/ledger.jsonl`, one record per call, paid or not. Payload capture defaults to `hash`:

| Level  | Bodies stored as                               |
| ------ | ---------------------------------------------- |
| `none` | Not recorded (byte counts only)                |
| `hash` | SHA-256 + key names + byte count (**default**) |
| `full` | Complete plaintext bodies                      |

`hash` is the default deliberately. Agents pass names, company data and eventually personal data through this tool; a default-on plaintext log of every payload is a data-protection liability and a second copy of sensitive data to secure. Turn `full` on per call, not globally. `telemetry.redactKeys` masks specific dot paths even at `full`. Auth-like headers are redacted at every level — only their presence is recorded.

```bash
x402 history --since 24h --paid-only
x402 history --sum
x402 history --by payTo --sum
```

An optional remote sink batches records to the Roundhouse indexer; sink failures never fail a call, and records queue in `~/.x402/outbox/` for the next invocation. See [`docs/telemetry.md`](docs/telemetry.md).

## The unified endpoint

Not every agent can shell out. `x402 serve` runs the same engine as a long-lived local service — same wallet, same gates, same ledger:

```bash
x402 serve                                  # HTTP on 127.0.0.1:8403
x402 serve --mcp                            # MCP server over stdio
x402 serve token create agent-1 --budget-daily 1.00 --max-per-call 0.01
```

```bash
curl -s -X POST http://127.0.0.1:8403/v1/call \
  -H "Authorization: Bearer $X402_TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: lei-roundhouse-1' \
  -d '{"url":"x402:lei","data":{"query":"Roundhouse AI Ltd."},"max":"0.01"}'
```

Routes: `POST /v1/call`, `POST /v1/probe`, `GET /v1/discover`, `GET /v1/history`, `GET /v1/health`. Errors carry the CLI exit code as `errorCode`, so one failure taxonomy covers all three surfaces. MCP mode exposes `x402_call`, `x402_probe`, `x402_discover` and `x402_history`.

**Treat it like a hot wallet API even on localhost.** It binds to `127.0.0.1`; anything that can reach it can spend. Callers need tokens (stored hashed) with their own daily and per-call budgets. Full details, including why `--host 0.0.0.0` demands `--i-understand-this-exposes-spending`, in [`docs/serve.md`](docs/serve.md).

## Wallets: bring your own

Signing goes through a **signer backend**, which sees one EIP-712 payload and nothing else — no URL, no request body, no response body. Four ship with the CLI:

| Backend              | What it is                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ows`                | Open Wallet Standard agent access layer: API-key auth, policy-gated signing. The default.                                                                                            |
| `local`              | Encrypted keystore (scrypt + AES-256-GCM), `0600`, warns on every signature. **Development and CI only** — it has no policy layer.                                                   |
| `exec`               | Any executable speaking [JSON over stdio](docs/exec-signer.md), in the style of git credential helpers. A hardware bridge, an MPC service or a KMS wrapper is one small script away. |
| `x402-signer-<name>` | Third-party backends, auto-discovered from npm.                                                                                                                                      |

```bash
x402 signer list                        # what is available, what is active
x402 signer check                       # capabilities, and whether this backend can do x402 at all
x402 call <url> --signer local --wallet dev
```

A backend that declares it cannot sign EIP-712 typed data fails when the signer is resolved (exit `47`) — before any request goes out, not halfway through a payment. A backend that refuses on policy grounds fails with exit `42`, and there is no second backend to fall back to. Details in [`docs/signers.md`](docs/signers.md).

## Configuration

`~/.x402/config.json`, overridden per project by `.x402rc`, overridden by flags. `env:`-prefixed values resolve from the environment at runtime, so secrets stay out of the file.

```json
{
  "wallet": {
    "backend": "ows",
    "default": "my-agent",
    "backends": {
      "ows": { "endpoint": "http://127.0.0.1:8402", "apiKey": "env:OWS_API_KEY" }
    }
  },
  "limits": { "maxPerCall": "0.05", "dailyCap": "5.00" },
  "allowlist": { "payTo": [], "domains": [] },
  "telemetry": { "payload": "hash", "sink": { "enabled": false } },
  "defaults": { "chain": "base", "timeout": 30 },
  "pins": { "lei": "https://provider.example/v1/lei" }
}
```

See [`docs/configuration.md`](docs/configuration.md).

## Status

**v0.1, pre-release.** v1 targets Base + USDC, the `exact` scheme, CLI and `serve` HTTP. Five questions block v1 — the load-bearing one is whether OWS exposes EIP-712 typed-data signing at all. They are tracked as issues and summarised in [`docs/roadmap.md`](docs/roadmap.md).

## Docs

- [`docs/SPEC.md`](docs/SPEC.md) — the design contract
- [`SKILL.md`](SKILL.md) — agent onboarding: three flows, both surfaces
- [`docs/architecture.md`](docs/architecture.md) — how the pieces fit
- [`docs/signers.md`](docs/signers.md) — wallet backends, and how to write one; [`docs/exec-signer.md`](docs/exec-signer.md) — the external signer protocol
- [`docs/exit-codes.md`](docs/exit-codes.md), [`docs/idempotency.md`](docs/idempotency.md), [`docs/telemetry.md`](docs/telemetry.md), [`docs/serve.md`](docs/serve.md), [`docs/configuration.md`](docs/configuration.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md), [`docs/releasing.md`](docs/releasing.md)

## Licence

Apache-2.0 © Roundhouse AI Ltd
