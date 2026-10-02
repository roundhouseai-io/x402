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

It is a Roundhouse client out of the box. `discover.indexUrl` ships pointing at `https://api.roundhouseai.io/v0` and `discover.unifiedUrl` at `/v0/unified`, so that one line reads the live Unified Services layer and prints every provider of a capability with the market around them — min, median, spot, spread — before you spend anything. The index caps a capability at 50 offers, so the listing says `truncated` when what you are looking at is not the whole market.

Then pay for one:

```bash
npx @roundhouseai/x402 https://blockrun.ai/api/v1/exa/answer --data.query "What is the LEI of Roundhouse AI Ltd.?"
```

A real, live endpoint — $0.011 USDC on Base. With a wallet configured, that line does: POST with a JSON body → receives 402 → checks the price against your limits → signs an EIP-3009 authorization → retries with the payment header the quoted x402 version uses (`X-PAYMENT` for v1, `PAYMENT-SIGNATURE` for v2) → prints the JSON body → writes a ledger entry.

> **One command, and why.** A global install puts **`rh-x402`** on your `PATH`, and nothing else. The unscoped `x402` package on npm is a different project that ships its own `x402` binary, so on a machine with both installed that short name would be a coin toss — this package no longer claims it. For the same reason the zero-install form is `npx @roundhouseai/x402`, never `npx x402`.

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
npm i -g @roundhouseai/x402      # then: rh-x402 <url>
npx @roundhouseai/x402 <url>     # or zero-install
```

Node 20.10+ is required. Then create a wallet — one command, and it asks the questions:

```bash
rh-x402 wallet create
```

It offers the three ways to hold a key, installs the OWS bindings if you pick that and they are missing, creates the wallet, writes the config, and prints the address to fund. Nothing is installed without asking, and the passphrase is typed at the prompt rather than passed as a flag.

```
How should this wallet hold its key?

  1) Open Wallet Standard  (recommended)
     The key stays encrypted in the OWS vault and is never handed to this CLI.
  2) Import a private key you already have
     Read from a key file into an encrypted keystore. Development and CI.
  3) Generate a key here  (not recommended)
     Same keystore, but the key is made by this tool. Throwaway wallets only.
```

The three are not equivalent, and the difference is what an attacker gets:

|                         | Where the key lives   | Needs                        | Does this CLI ever hold the key?                        |
| ----------------------- | --------------------- | ---------------------------- | ------------------------------------------------------- |
| **OWS** _(recommended)_ | An OWS vault          | `@open-wallet-standard/core` | **No** — it sends one payload and gets a signature back |
| **Import**              | An encrypted keystore | `ethers`                     | Yes — decrypted in this process to sign                 |
| **Generate**            | An encrypted keystore | `ethers`                     | Yes — same, and the key is made here                    |

**Ask for the policy when it offers.** An OWS wallet is owner access by default: this CLI can sign anything the key can sign. `wallet create` offers to register a policy and mint an OWS API key bound to it, and from then on OWS refuses a chain or token contract outside x402 _before the key is decrypted_, whatever this CLI does:

```
$ rh-x402 pay @402-from-a-rogue-contract.json
{"ok": false, "errorCode": 42, "errorName": "policy_denied",
 "error": "ows-core refused to sign: policy denied: verifyingContract 0xdeAdbeef… not in allowed list"}
```

Add one later with `rh-x402 wallet policy`. **But note what it cannot do: cap an amount.** OWS's rules are chains, token contracts and expiry — a policy bounds _what_ may be signed, never _how much_. `limits.maxPerCall` and `limits.dailyCap` are still the only amount caps, still computed from a local ledger by the process that signs, and still advisory. Full detail in [`docs/signers.md`](docs/signers.md).

Non-interactively, for a script or an agent:

```bash
rh-x402 wallet create --path ows --name my-agent --install --policy
rh-x402 wallet create --path import --name dev --key-file ./testnet.key
```

Or point it at an OWS HTTP service you already run — note `@open-wallet-standard/core` ships **no** daemon, so this is only for a separate OWS service; `ows-core` above is the in-process path:

```bash
rh-x402 config set wallet.backend ows
rh-x402 config set wallet.backends.ows.endpoint http://127.0.0.1:8402
rh-x402 config set wallet.backends.ows.apiKey env:OWS_API_KEY   # an indirection, never the secret
rh-x402 config set wallet.default my-agent
rh-x402 config set limits.maxPerCall 0.05
rh-x402 signer check     # does this backend do what x402 needs?
rh-x402 wallet list
```

## Is the wallet funded?

```bash
rh-x402 wallet balance                       # the active wallet, on defaults.chain
rh-x402 wallet balance --chain base --chain ethereum
rh-x402 wallet balance --address 0x2D43…14C  # any address
```

```
base (0x2D43136FfBbbe0ED5CBaaB2E8B2b8c968059114C)
  0                        ETH  (gas)
  0.928                    USDC
  can pay x402 here: yes (x402 needs no ETH; the facilitator pays the gas)
```

`--address` reads any address and needs no wallet configured at all — the balance comes from the chain, so no signer has to resolve first.

Read from the chain over JSON-RPC, so it gives the same answer for every backend — `ows-core` exports no balance function and the `local` keystore has nothing to ask, which used to make this a per-backend capability that mostly answered "cannot". Base, Ethereum and Base Sepolia ship with public endpoints; override one with `rh-x402 config set rpc.base <url>`.

**That last line matters.** An x402 payment is an EIP-3009 authorization the facilitator submits, so the payer needs USDC and **no ETH at all**. A zero ETH balance does not stop an x402 call — it only stops a direct on-chain transfer, which is a different thing. `wallet balance` exits `46` when the token balance is zero, and never on the gas balance.

Nothing in the payment path calls an RPC, so a rate-limited endpoint costs you this command and nothing else.

## Where am I?

```bash
rh-x402 status            # a table
rh-x402 status --json     # one JSON object
```

Read-only: it never pays, never signs and never prompts. It reports the CLI and Node versions, the signer (how the key is held, its address, whether it can sign typed data, whether an OWS policy is in force), the USDC balance read from the chain, both spend caps, whether an API key is set (never the key), telemetry, today's spend, and `next`.

`next` is one of `install`, `create-wallet`, `set-caps`, `fund`, `first-payment`, `store-key` or `ready`. It is the first step that is not done, and the names are the section headings of [roundhouseai.io/skill.md](https://roundhouseai.io/skill.md). The command exits `0` only when `next` is `ready`, so a script can gate on it. A config that will not parse, a signer that is down and an RPC that will not answer are reported as fields, not as a crash.

`--min-balance <usdc>` sets the balance `fund` is judged against (default `1.00`). Once a payment is on the local ledger the wallet counts as funded whatever it holds now, so spending below the floor never sends a finished setup back to `fund`.

## Zero to paid: the whole thing

Every command, in order, from an empty machine to a receipt. Nine steps, three of which are optional.

### 1. Install

```bash
npm i -g @roundhouseai/x402      # puts `rh-x402` on your PATH
```

### 2. Look around before committing to anything

```bash
rh-x402 discover web-search
```

No wallet, no key, no config. Read the market first: `median` is the going rate, `spot` is what callers actually pay, and a wide `spread` means the cheapest offer deserves a second look.

### 3. Create a wallet

```bash
rh-x402 wallet create
```

It asks how the key should be held, installs the OWS bindings if you pick that, creates the wallet, writes the config, and prints the address. Non-interactively:

```bash
rh-x402 wallet create --path ows --name my-agent --install --policy
```

### 4. Put a policy in front of it _(recommended, OWS only)_

```bash
rh-x402 wallet policy --chain base --expires 90d
export OWS_X402_KEY=ows_key_…      # shown once; OWS cannot show it again
```

From here OWS refuses any chain or token contract outside x402 **before the key is decrypted**, whatever this CLI does. Without it you have owner access and only the CLI-side caps. See [the policy gate](docs/signers.md) for what it can and cannot bound.

### 5. Set a spend cap

```bash
rh-x402 config set limits.maxPerCall 0.05
rh-x402 config set limits.dailyCap 5.00
```

### 6. Fund the address — with USDC, not ETH

```bash
rh-x402 wallet address      # send USDC on Base to this
rh-x402 wallet balance
```

```
base (0x2D43136FfBbbe0ED5CBaaB2E8B2b8c968059114C)
  0                        ETH  (gas)
  0.928                    USDC
  can pay x402 here: yes (x402 needs no ETH; the facilitator pays the gas)
```

### 7. Check the wallet is wired up

```bash
rh-x402 signer check
# {"ok":true,"backend":"ows-core","capabilities":{"typedData":true,"policies":true,…},
#  "address":"0x2D43…14C"}
```

`typedData: true` is the one that matters — a backend that cannot sign EIP-712 fails here, at config time, rather than halfway through a payment. `policies: true` means a signature cannot bypass your OWS policy.

### 8. Price the call before making it

```bash
rh-x402 probe https://blockrun.ai/api/v1/exa/answer
# {"ok":true,"status":402,"paymentRequired":true,
#  "selected":{"amount":"0.011","asset":"usdc","network":"base","payTo":"0x1831…"}}
```

`probe` never pays. Compare `amount` against what `discover` said the market charges.

### 9. Pay

```bash
rh-x402 call https://blockrun.ai/api/v1/exa/answer \
  --data.query "What is the LEI of Roundhouse AI Ltd.?" \
  --max 0.02
```

```json
{
  "ok": true,
  "status": 200,
  "paid": true,
  "amount": "0.011",
  "asset": "usdc",
  "receiptId": "01J8ZK…",
  "body": { "answer": "…" }
}
```

Or let the index pick: `rh-x402 call x402:web-search --data.query "…" --max 0.02` resolves to the cheapest live allowed provider.

### After: the audit trail

```bash
rh-x402 history --since 24h          # every call, paid or not
rh-x402 verify 01J8ZK…               # confirm settlement of one receipt
```

## What actually gets signed

**This CLI never sends a transaction.** It signs one thing — an **EIP-3009 `TransferWithAuthorization`**, as EIP-712 typed data — and hands it to the provider in a payment header. The provider's facilitator submits it on-chain and pays the gas. That is why the payer needs USDC and no ETH, and why there is no nonce management, no gas estimation and no broadcast anywhere in this tool.

The payload is exactly this, and nothing else reaches your signer:

```json
{ "types": { "EIP712Domain": [...], "TransferWithAuthorization": [...] },
  "primaryType": "TransferWithAuthorization",
  "domain": { "name": "USD Coin", "version": "2", "chainId": 8453,
              "verifyingContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "message": { "from": "0x2D43…", "to": "0x1831…", "value": "11000",
               "validAfter": "0", "validBefore": "1787903518",
               "nonce": "0x0f42b251…" } }
```

**The engine never sees a key.** It builds that payload, passes it to a `SignerBackend`, and gets 65 bytes back. The backend receives no URL, no request body and no response body — a buggy or hostile backend cannot exfiltrate what it never sees.

### Signing without making a request

`pay` runs the signing half on its own — useful for testing a wallet, for building the header somewhere else, or for signing on a machine that will not make the call:

```bash
curl -sS -o 402.json https://api.example.com/v1/thing   # the provider's own 402 body
rh-x402 pay @402.json
```

`pay` wants the **provider's own 402**, not `probe`'s output — `probe` prints this CLI's envelope, which normalises the options and drops fields `pay` needs. The 402 may be its JSON body, the base64 value of a `PAYMENT-REQUIRED` header, or a whole header line; `@file`, a literal argument and `-` for stdin all work.

```json
{ "ok": true,
  "headerName": "PAYMENT-SIGNATURE",
  "header": "eyJ4NDAyVmVyc2lvbiI6Miwi…",
  "payload": { "x402Version": 2,
               "accepted": { "scheme": "exact", "network": "eip155:8453", … },
               "payload": { "signature": "0x67b9b0bf…1b", "authorization": { … } } },
  "receipt": { "id": "01M13M…", "backend": "ows-core", "from": "0x2D43…" } }
```

Send `header` under the name in `headerName` on your own request and the provider can settle it. That name follows the quote's protocol version — `X-PAYMENT` for x402 v1, `PAYMENT-SIGNATURE` for v2 — and so does the payload shape. The payment is authorised at that point, not settled: settlement is the facilitator's on-chain submission, which `rh-x402 verify <receiptId>` confirms.

### Where the signature comes from

| Backend                    | Signs with                                             | Key ever in this process?    | Policy layer                          |
| -------------------------- | ------------------------------------------------------ | ---------------------------- | ------------------------------------- |
| `ows-core` _(recommended)_ | `@open-wallet-standard/core`, in process               | **No**                       | With an API key — see `wallet policy` |
| `ows`                      | An OWS HTTP service you run                            | **No**                       | Yes, the service's                    |
| `local`                    | An encrypted keystore + `ethers`                       | Yes, decrypted per signature | No                                    |
| `exec`                     | Any executable, [JSON over stdio](docs/exec-signer.md) | Whatever it does             | Whatever it does                      |

Two rules hold across all of them: a backend that declares it cannot sign typed data is rejected when the signer resolves (exit `47`), not mid-payment; and there is **no fallback** — if the chosen backend refuses, the call fails with exit `42`.

## The three flows

**What does this cost?** `probe` never pays.

```bash
rh-x402 probe https://api.example.com/v1/lei
# {"ok":true,"status":402,"paymentRequired":true,
#  "selected":{"amount":"0.002","asset":"usdc","network":"base","payTo":"0x1831…"}}
```

**Get the data.** `call` pays if a price is quoted and your gates allow it.

```bash
rh-x402 call https://api.example.com/v1/lei --data.query "Roundhouse AI Ltd." --max 0.01
# {"ok":true,"status":200,"paid":true,"paymentState":"settled","amount":"0.002",
#  "asset":"usdc","receiptId":"01J8ZK…","body":{"lei":"213800…"}}
```

`paymentState` is the honest detail behind `paid`: `none` (nothing signed),
`signed` (signed, then rejected by the provider — nothing settled), `submitted`
(the provider accepted it; assume the money moved) or `settled` (a settlement
receipt confirms it). Only `signed` and `none` mean the wallet is untouched.

**Who sells this cheapest?** `discover` asks the Roundhouse index, and reports the whole market — not just a list — so an agent can tell a fair price from a gouging one before it spends.

```bash
rh-x402 discover web-search
# min 0.001 · median 0.01 · spot 0.0164 · max 0.63 per search (630x spread over 122 offers)
#      0.011 usdc  https://blockrun.ai/api/v1/exa/search 42 payers

rh-x402 call x402:web-search --data.query "..."   # resolve, then call the cheapest live allowed provider
```

`stats` carries `min`, `p25`, `median`, `p75`, `max`, `spread` (max ÷ min) and `spot` (the average actually paid, call-weighted). Judge an offer against `median` for the going rate and against `spot` for what the market really pays; a wide `spread` means the list needs reading rather than trusting.

## Commands

| Command                                         | Purpose                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `rh-x402 call <url>`                            | Full request + pay + retry loop (the default command)              |
| `rh-x402 probe <url>`                           | Fetch 402 payment requirements only. Never pays.                   |
| `rh-x402 pay <402-json\|base64>`                | Sign a payment header (x402 v1 or v2) from a 402 payload. No HTTP. |
| `rh-x402 verify <receipt>`                      | Confirm settlement of a prior payment                              |
| `rh-x402 discover <capability>`                 | Providers for a capability, with the market around them            |
| `rh-x402 history [query]`                       | Query the local ledger                                             |
| `rh-x402 status`                                | Where setup stands and which step is next. Never pays.             |
| `rh-x402 wallet create`                         | Guided setup: pick how the key is held, configure it               |
| `rh-x402 wallet policy`                         | Register an OWS policy and mint the API key that carries it        |
| `rh-x402 wallet balance [usdc]`                 | Native and token balances, read from the chain over RPC            |
| `rh-x402 wallet <list\|address>`                | Wallet queries against the signer backend                          |
| `rh-x402 wallet forget <name>`                  | Hide a wallet from this CLI. Never deletes it.                     |
| `rh-x402 signer <list\|check>`                  | Inspect signer backends and their capabilities                     |
| `rh-x402 signer keystore <list\|add\|generate>` | Manage the local development keystore                              |
| `rh-x402 serve`                                 | Run the unified local endpoint (HTTP, plus MCP with `--mcp`)       |
| `rh-x402 config <get\|set\|unset\|list>`        | Manage `~/.x402/config.json`                                       |

`rh-x402 <url>` is sugar for `rh-x402 call <url>`.

## Passing data

Three mechanisms, combinable. Later sources win on key collision: **dot flags > `--json` > stdin**.

```bash
rh-x402 call https://api.example.com/v1/screen \
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
rh-x402 call <url> --json '{"company":{"name":"Roundhouse AI Ltd."}}'
rh-x402 call <url> --json @payload.json
cat payload.json | rh-x402 call <url> --json -
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
rh-x402 call https://api.example.com/v1/lei --max 0.01 --budget 0.50 --dry-run
```

`--dry-run` runs everything up to and including the gates, prints what would be paid, and stops before signing.

## Idempotency

The signed authorization is cached at `~/.x402/authcache/`, keyed by the request identity (url, method, body, payTo, amount, asset, chain, wallet). If the paid retry times out or dies at the network layer, re-running the same command **reuses the cached authorization** instead of signing a new one. Entries expire at the authorization's own `validBefore`.

```bash
rh-x402 call https://api.example.com/v1/lei          # times out after paying → exit 50
rh-x402 call https://api.example.com/v1/lei          # reuses the authorization, cacheHit: true
rh-x402 call https://api.example.com/v1/lei --no-cache   # pay AGAIN, on purpose — not an error escape
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

**2. `wallet balance` does not ask the backend, but the engine's pre-flight check does.** The command reads the chain over JSON-RPC, so it answers on every backend — including one whose `signer check` reports `balances: false`, which most do. What that capability actually gates is the engine's pre-flight funding check, which it skips rather than guessing: a call can still fail at the provider for want of funds even where `signer check` looked fine. Run `rh-x402 wallet balance` yourself before a batch of calls rather than relying on the pre-flight.

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
rh-x402 history --since 24h --paid-only
rh-x402 history --sum
rh-x402 history --by payTo --sum
```

An optional remote sink batches records to the Roundhouse indexer; sink failures never fail a call, and records queue in `~/.x402/outbox/` for the next invocation. See [`docs/telemetry.md`](docs/telemetry.md).

## The unified endpoint

Not every agent can shell out. `rh-x402 serve` runs the same engine as a long-lived local service — same wallet, same gates, same ledger:

```bash
rh-x402 serve                                  # HTTP on 127.0.0.1:8403
rh-x402 serve --mcp                            # MCP server over stdio
rh-x402 serve token create agent-1 --budget-daily 1.00 --max-per-call 0.01
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

Signing goes through a **signer backend**, which sees one EIP-712 payload and nothing else — no URL, no request body, no response body. Five ship with the CLI:

| Backend              | What it is                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ows`                | Open Wallet Standard agent access layer over HTTP: API-key auth, policy-gated signing. The default.                                                                                       |
| `ows-core`           | The same vault in process, via the `@open-wallet-standard/core` bindings. No daemon to run, the key never leaves OWS, and `wallet policy` puts an OWS policy in front of every signature. |
| `local`              | Encrypted keystore (scrypt + AES-256-GCM), `0600`, warns on every signature. **Development and CI only** — it has no policy layer.                                                        |
| `exec`               | Any executable speaking [JSON over stdio](docs/exec-signer.md), in the style of git credential helpers. A hardware bridge, an MPC service or a KMS wrapper is one small script away.      |
| `x402-signer-<name>` | Third-party backends, auto-discovered from npm.                                                                                                                                           |

```bash
rh-x402 signer list                        # what is available, what is active
rh-x402 signer check                       # capabilities, and whether this backend can do x402 at all
rh-x402 call <url> --signer local --wallet dev
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
