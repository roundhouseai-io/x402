# x402

**One command for the whole x402 payment loop.** Request, 402, sign, retry, receipt — with spend limits, a local ledger, and no private keys anywhere near your shell.

[![CI](https://github.com/roundhouseai-io/x402/actions/workflows/ci.yml/badge.svg)](https://github.com/roundhouseai-io/x402/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@roundhouseai/x402.svg)](https://www.npmjs.com/package/@roundhouseai/x402)
[![node](https://img.shields.io/node/v/@roundhouseai/x402.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Start here — this needs no wallet, no key and no config:**

```bash
npx @roundhouseai/x402 discover web-search
```

It is a Roundhouse client out of the box. `discover.indexUrl` ships pointing at `https://www.roundhouse.studio/api/v0` and `discover.unifiedUrl` at `/unified.json`, so that one line reads the live Unified Services layer and prints every provider of a capability with the market around them — min, median, spot, spread — before you spend anything.

Then pay for one:

```bash
npx @roundhouseai/x402 https://blockrun.ai/api/v1/exa/answer --data.query "What is the LEI of Roundhouse AI Ltd.?"
```

A real, live endpoint — $0.011 USDC on Base. With a wallet configured, that line does: POST with a JSON body → receives 402 → checks the price against your limits → signs an EIP-3009 authorization → retries with `X-PAYMENT` → prints the JSON body → writes a ledger entry.

> **Two commands, and why.** A global install gives you **`rh-x402`** and `x402`. Prefer `rh-x402` in anything you commit: the unscoped `x402` package on npm is a different project that also ships an `x402` binary, so on a machine with both installed the short name is a coin toss. For the same reason the zero-install form is `npx @roundhouseai/x402`, never `npx x402`.

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
npm i -g @roundhouseai/x402      # then: rh-x402 <url>   (or x402, see above)
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

**Who sells this cheapest?** `discover` asks the Roundhouse index, and reports the whole market — not just a list — so an agent can tell a fair price from a gouging one before it spends.

```bash
x402 discover web-search
# min 0.001 · median 0.01 · spot 0.0164 · max 0.63 per search (630x spread over 122 offers)
#      0.011 usdc  https://blockrun.ai/api/v1/exa/search 42 payers

x402 call x402:web-search --data.query "..."   # resolve, then call the cheapest live allowed provider
```

`stats` carries `min`, `p25`, `median`, `p75`, `max`, `spread` (max ÷ min) and `spot` (the average actually paid, call-weighted). Judge an offer against `median` for the going rate and against `spot` for what the market really pays; a wide `spread` means the list needs reading rather than trusting.

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
x402 call https://api.example.com/v1/lei --no-cache   # pay AGAIN, on purpose — not an error escape
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

| Code | Meaning                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success (paid or free)                                                                                                                                               |
| 1    | Generic / network error                                                                                                                                              |
| 40   | Invalid 402 payload (endpoint not x402-compliant)                                                                                                                    |
| 42   | Denied by OWS policy                                                                                                                                                 |
| 43   | Denied by payTo/domain allowlist                                                                                                                                     |
| 44   | Price exceeds `--max`                                                                                                                                                |
| 45   | Session budget or daily cap exhausted                                                                                                                                |
| 46   | Insufficient wallet balance                                                                                                                                          |
| 47   | Signer backend unreachable, unauthenticated, **or unable to do what was asked** (see below)                                                                          |
| 50   | Payment sent, but no valid response returned. **Money may have moved.** Re-run the _identical_ command — it reuses the cached authorization. Never add `--no-cache`. |

These are a stability contract from v1. See [`docs/exit-codes.md`](docs/exit-codes.md).

## Four things that cost money if you get them wrong

Found by driving the published package against production, not by reading the source. Each was a gap between what this README said and what the tool does.

**1. `--no-cache` is the double-payment path, never the escape from an error.** It forces a fresh signature and writes none, so the next identical call signs again too. After exit `50` — payment sent, response lost — the correct move is to re-run the _identical_ command: the cached authorization is reused and you either get the response you already paid for or fail cleanly. Adding `--no-cache` there is how you pay twice. Use it only when you actually mean "bill me again".

**2. `wallet balance` is not universal, and its failure looks like an outage.** Balance reporting is a per-backend capability. The `local` backend does not have it, so the command exits `47` with `the local backend cannot report balances` — the same code you would get if OWS were down. Do not read that as an infrastructure problem, and do not treat a missing balance as zero. Check with `x402 signer check`, and where the backend cannot answer, read the token contract directly for your funding pre-flight. The engine skips the pre-flight check rather than guessing, so a call can still fail at the provider for want of funds.

**3. The `local` backend needs `ethers`, and refuses a loose key file.** It is the only part of the tool that signs locally, and `ethers` is an _optional_ peer dependency — a default install carries no signing code at all, which is deliberate. Without it you get exit `47` and `needs the optional peer dependency ethers (npm i ethers)`. It also refuses to read a group- or world-readable keystore (`chmod 600` it) and a world-readable raw key file. Those refusals are the feature; do not chmod around them.

**4. `npx x402` is a different project.** The unscoped name on npm belongs to someone else. Zero-install is `npx @roundhouseai/x402`; a global install gives you `rh-x402` (unique) alongside `x402` (short, and contested). Scripts should say `rh-x402`.

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
