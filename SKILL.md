---
name: x402
description: Pay for HTTP APIs with x402. Use when a request returns HTTP 402, when an API needs per-call payment, when you need the price of a paid endpoint before calling it, or when you need to find the cheapest provider of a capability. Covers the x402 CLI and the local unified endpoint.
---

# x402

Three flows, two surfaces, one failure taxonomy.

| Flow       | Question it answers                                                 | Needs a wallet? |
| ---------- | ------------------------------------------------------------------- | --------------- |
| `discover` | Who sells this capability, and what is the going rate?              | No              |
| `probe`    | What does this cost? (never pays)                                   | No              |
| `call`     | Get me the data (pays if a price is quoted and the limits allow it) | Yes             |

**Start with `discover`.** It needs no wallet, no key and no config: `discover.indexUrl` and `discover.unifiedUrl` ship pointing at the Roundhouse index, so `rh-x402 discover <capability>` reads the live Unified Services layer immediately and returns every provider with the market around them — `min`, `median`, `spot`, `spread`. Price an offer against that before spending, rather than paying the first endpoint you were handed.

**The command is `rh-x402`.** There is no `x402` binary: the unscoped `x402` package on npm is a different project that ships its own, so this package does not claim that name. Zero-install is `npx @roundhouseai/x402`, never `npx x402`.

**Surfaces.** The CLI (`rh-x402 …`; the binary is `rh-x402`, not `x402`) and the local unified endpoint (`http://127.0.0.1:8403`, started with `rh-x402 serve`). They share one wallet, one set of spend gates, one ledger and one set of error codes. Use the CLI if you can run commands; use the endpoint if you cannot.

**Money is real.** Every `call` may spend from a live wallet. Always pass a per-call cap you are willing to pay. When you do not know the price, `probe` first.

## 1. probe — what does this cost?

CLI:

```bash
rh-x402 probe https://api.example.com/v1/lei
```

Endpoint:

```bash
curl -s -X POST http://127.0.0.1:8403/v1/probe \
  -H "Authorization: Bearer $X402_TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://api.example.com/v1/lei"}'
```

Both return:

```json
{
  "ok": true,
  "status": 402,
  "paymentRequired": true,
  "selected": {
    "amount": "0.002",
    "asset": "usdc",
    "network": "base",
    "payTo": "0x1831…",
    "scheme": "exact"
  }
}
```

`paymentRequired: false` means the endpoint is free — just call it. `probe` never signs and never spends.

## 2. call — get the data

CLI:

```bash
rh-x402 call https://api.example.com/v1/lei --data.query "Roundhouse AI Ltd." --max 0.01
```

Endpoint:

```bash
curl -s -X POST http://127.0.0.1:8403/v1/call \
  -H "Authorization: Bearer $X402_TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: lei-roundhouse-ai-1' \
  -d '{"url":"https://api.example.com/v1/lei","method":"GET","data":{"query":"Roundhouse AI Ltd."},"max":"0.01"}'
```

Both return the same envelope:

```json
{
  "ok": true,
  "status": 200,
  "paid": true,
  "paymentState": "settled",
  "amount": "0.002",
  "asset": "usdc",
  "receiptId": "01J8ZK3M9Q…",
  "body": { "lei": "213800…" }
}
```

The response body you want is `body`. `amount` is what it cost; `receiptId` is what you quote if you need to verify settlement later (`rh-x402 verify <receiptId>`).

`paid` and `paymentState` together say what happened to your money:

| `paymentState` | `paid`  | What it means                                                                          |
| -------------- | ------- | -------------------------------------------------------------------------------------- |
| `none`         | `false` | Nothing was signed. The wallet is untouched; a retry is free.                          |
| `signed`       | `false` | An authorization was signed and the provider rejected it. Nothing settled.             |
| `submitted`    | `true`  | The authorization reached the provider and was accepted. Assume the money moved.       |
| `settled`      | `true`  | A settlement receipt confirms the transfer. `rh-x402 verify` can show the transaction. |

Most providers return no settlement receipt, so `submitted` is the normal
success state — it is not a warning. `signed` is the one to act on: the call
failed and the wallet was not charged, so read `error` before retrying.

**Passing data.** `--data.<path> <value>` builds nested JSON: dots for objects, `[n]` for arrays.

```bash
rh-x402 call https://api.example.com/v1/screen \
  --data.company.name "Roundhouse AI Ltd." \
  --data.checks[0] sanctions \
  --data.checks[1] pep \
  --data.limit 10
```

Numbers, `true`/`false` and `null` are coerced; anything else is a string. Force a string with `str:` (`--data.postcode str:10001`). `--json '{"…"}'`, `--json @file.json` and `cat f | … --json -` are equivalent whole-payload forms. GET sends data as query params; POST sends a JSON body. On the endpoint, pass the same structure as `data`.

**Spending safely.**

- `--max 0.01` (CLI) or `"max": "0.01"` (endpoint) refuses anything pricier. Always set it. With no cap configured, a per-call limit of `1.00` USDC and a daily cap of `5.00` USDC still apply; never raise them without a human's say.
- `--dry-run` reports the price and stops before signing. Use it when you are unsure.
- Repeat the _same_ command after a network failure: the signed authorization is cached and reused, so a retry does not pay twice. On the endpoint, send the same `Idempotency-Key`.
- `--budget 0.50` caps everything this process spends.

**Protocol versions.** x402 v1 and v2 are both spoken, and the version is taken
from the provider's own 402 — v1 signs into `X-PAYMENT`, v2 into
`PAYMENT-SIGNATURE`. A provider quoting a version this build does not know fails
with exit `40` _before_ anything is signed, so an unknown version never costs
money.

## 3. discover — who sells this cheapest?

CLI:

```bash
rh-x402 discover web-search
rh-x402 call x402:web-search --data.query "..." --max 0.02
```

Endpoint:

```bash
curl -s -H "Authorization: Bearer $X402_TOKEN" \
  'http://127.0.0.1:8403/v1/discover?capability=web-search'
```

```json
{
  "ok": true,
  "capability": "web-search",
  "unit": "per search",
  "count": 2,
  "stats": {
    "min": "0.001",
    "p25": "0.005",
    "median": "0.01",
    "p75": "0.02",
    "max": "0.63",
    "spread": 630,
    "spot": "0.0164",
    "spotBasis": "calls",
    "offers": 122,
    "priced": 122,
    "unpriced": 0,
    "providers": 68,
    "live": 121
  },
  "truncated": true,
  "providers": [
    {
      "url": "https://blockrun.ai/api/v1/exa/search",
      "price": "0.011",
      "asset": "usdc",
      "chain": "base",
      "live": true,
      "calls30d": 2411,
      "payers30d": 42
    }
  ]
}
```

**Selecting.** `stats` is the whole market for that capability, so you can price one offer against it rather than against nothing:

- `median` — the going rate. Paying far above it needs a reason.
- `spot` — the average actually paid, weighted by calls. Above `median` means demand sits on the dearer offers.
- `spread` — `max / min`. A wide spread means the cheapest offer is not automatically the sane one; read the list.
- `payers30d` — distinct wallets that paid this endpoint. Corroboration, and harder to fake than call count.
- `live` — `false` means the index could not reach it last probe. `discover` still lists it, marked `[down]`; resolution never routes to it.
- `unpriced` — offers the index could not price. The quantiles describe the priced ones only, so a large `unpriced` means they cover less of the market than `offers` suggests.

**`truncated: true` means `providers` is not the whole market.** The index caps a capability at 50 offers while `stats` describe every offer there is, so the cheapest listed is the cheapest that came back, not the cheapest that exists. `stats.min` is the real floor. Do not report the head of a truncated list as the market low, and do not conclude a capability has only the providers shown.

`stats` is `null` when the capability is not a registered slug — the index then answers from a keyword search, which returns offers but no market-wide pricing. Figures are an indexed snapshot: always read the live 402 before paying.

**The default rule: `--policy`.** `rh-x402 discover <capability> --policy` splits the offers into those a careful buyer would pay and those it would not, and says why for each. An offer passes only if it is live, has had at least one paying wallet in the last 30 days (`payers30d > 0`) and costs no more than 1.5 times `spot` (change the factor with `--spot-factor`). An offer whose liveness or payer count is unknown fails: no evidence that anyone has paid it is exactly what the rule is there to catch. The passing list is `providers`; the rest are under `policy.rejected`, each with its `reasons`. If the index reports no `spot`, the price rule is skipped and `policy.priceRule` says `skipped`. Use this unless a human told you which provider to use.

A capability URI (`x402:web-search`) can be used anywhere a URL can. It resolves through configured pins first, then the index, picking the cheapest allowed provider the index reports as live. The provider actually used appears in the response envelope, so prefer capabilities over hard-coded vendor URLs.

## Where am I? — `status`

```bash
rh-x402 status --json
```

Read-only; never pays, signs or prompts. Run it first when you are resuming. `next` is the first step not yet done: `install`, `create-wallet`, `set-caps`, `fund`, `first-payment`, `store-key` or `ready`. Exit `0` means `ready`; anything else exits `1` with the report still on stdout. `auth.apiKey` is `set` or `unset`, never the key.

## Setting up — `setup`

```bash
rh-x402 setup --yes --json
```

From nothing to a stored API key. Idempotent: run it again and it skips what is done. Resumable: kill it and the next run starts at the step that did not finish. Steps, in order, named as `status`'s `next`: `environment`, `state`, `decisions`, `create-wallet`, `set-caps`, `fund`, `first-payment`, `store-key`, `summary`. With `--json` each step is one JSON object with `step`, `result` (`done`, `skipped`, `planned`, `failed`) and `message`. A failure exits with the step's own exit code and names the step.

`--yes` takes the defaults: key held by OWS, `0.05` per call, `5.00` a day, no org key. If the operator gave you a different custody (`--path import|generate`), caps or an org key (`--org-key env:NAME`), pass those flags; do not pick other values yourself. Telemetry is on and is not asked; pass `--telemetry off` only if the operator opted out. It stops at `fund` until someone sends USDC to the printed address on Base. It never prints the API key unless `--print-key`. The OWS policy key is shown once: export it as `OWS_X402_KEY` in every shell that pays. `--dry-run` makes no wallet, no config write and no payment.

**`--path import` and `--path generate` need two things before you start.** Both are checked up front, reported together, and nothing is written until both are there:

1. **`X402_KEYSTORE_PASS`**, exported with the passphrase that encrypts the key. The wallet config then reads it as `env:X402_KEYSTORE_PASS`, so every shell that pays needs it too. `status` warns when it is missing.
2. **`ethers`**, installed next to this CLI. It is an optional peer dependency, so bare `npx @roundhouseai/x402` cannot sign with a keystore. Use `npx -p @roundhouseai/x402 -p ethers rh-x402 ...`, or `npm i @roundhouseai/x402 ethers` in a project. `npm i ethers` in some other directory does not help.

```bash
export X402_KEYSTORE_PASS='a long passphrase'
npx -p @roundhouseai/x402 -p ethers rh-x402 setup --path generate --max-per-call 0.05 --daily-cap 5 --yes --json
```

**Set leaves, not groups.** `config set telemetry on` is refused: `telemetry` is a group. The switch is `config set telemetry.sink.enabled true` (`on`/`off` are accepted for it).

## Exit codes

The CLI exits with these; the endpoint returns the same number as `errorCode` (and MCP as `errorCode` inside the tool result). Branch on the number, not the message.

| Code | Name                   | Meaning                                                                            | What to do next                                                                                                          |
| ---- | ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0    | `ok`                   | Success, paid or free                                                              | Use the body.                                                                                                            |
| 1    | `error`                | Generic, network or usage error. Nothing was paid.                                 | Read the message. A network error is safe to retry.                                                                      |
| 40   | `invalid_402`          | The endpoint answered a 402 this CLI cannot use, or rejected a valid authorization | Do not retry. Report the endpoint.                                                                                       |
| 42   | `policy_denied`        | The wallet policy refused to sign                                                  | Stop. A human must widen the wallet policy.                                                                              |
| 43   | `allowlist_denied`     | An allowlist excluded this domain or payee                                         | Stop. The provider is not approved.                                                                                      |
| 44   | `over_max`             | The quoted price is above --max or limits.maxPerCall                               | Probe for the live price. Raise --max only if a human allowed it.                                                        |
| 45   | `budget_exhausted`     | --budget for this process or limits.dailyCap is spent                              | Stop spending and report it.                                                                                             |
| 46   | `insufficient_balance` | The wallet cannot cover the quoted price                                           | Stop. Fund the wallet, then run `wallet balance --wait`.                                                                 |
| 47   | `ows_unavailable`      | The signer is unreachable, rejected its credential, or cannot sign typed data      | Read the message. If it names a missing package, install it. Otherwise retry once, then report the wallet layer as down. |
| 48   | `wait_timeout`         | `wallet balance --wait` timed out before the balance arrived                       | Check the address and chain with the human, then wait again or report it.                                                |
| 50   | `paid_no_response`     | The payment was sent and no valid response came back. Money may have moved.        | Re-run the identical command. Never add --no-cache.                                                                      |

## Waiting for funds

```bash
rh-x402 wallet balance --wait --min 1.00 --timeout 30m
```

Polls the chain until the wallet holds at least `--min` USDC (default `1.00`) or `--timeout` passes (default `30m`; a bare number is seconds). Exit `0` when it is met, `48` when time ran out. A failed RPC read does not end the wait; the last error is reported only if the wait times out. A progress line goes to stderr at most once a minute. Without `--wait`, `--min` checks once and exits `46` if the balance is short.

## The Roundhouse API key

`rh-x402 config set auth.apiKey env:ROUNDHOUSE_API_KEY` stores a reference; the key itself stays in the environment. The CLI sends it as `Authorization: Bearer` to `roundhouseai.io` hosts over https, and nowhere else. It never replaces an `Authorization` header you pass yourself. `config get`, `config list` and `status` show `[redacted]` or `set`, never the value. To store a literal, pipe it in (`… auth.apiKey -`) rather than putting it on the command line.

## Do and do not

- **Do** pass `--max` on every call, and `probe` when you do not know the price.
- **Do** re-run the identical command after a transient failure; that is what makes retries safe.
- **Do** use `x402:<capability>` rather than pinning a vendor URL, unless determinism matters more than price.
- **Do not** add `--no-cache` to work around an error — it is the double-payment path.
- **Do not** ask for or handle private keys. Signing belongs to the wallet backend, which only ever sees the payment authorization; there is no key flag. If no wallet is configured, say so and stop: tell the human to run `rh-x402 wallet create`, and let them answer it. Where money lives is their decision, not a step to improvise.
- **Do not** turn on `--telemetry-payload full` for calls carrying personal data; the default (`hash`) exists for that reason.
- **Do not** treat exit 42/43/45/46 as retryable. They need a human decision.
- **Do not** read exit 47 as "the wallet is down" without reading the message; half the time it means the backend cannot do the thing at all, and retrying is pointless.
- **Do not** treat an unavailable balance as a zero balance. See below.
- **Do not** read "insufficient funds for gas" as "x402 needs ETH". The facilitator submits the transfer and pays the gas; the wallet needs USDC and nothing else. `wallet balance` reports `canPayX402` on the token balance alone.

## Backend capabilities are not uniform

Run `rh-x402 signer check` before relying on anything beyond signing. Backends declare what they can do, and the two that bite:

- **Balances do not come from the backend.** `rh-x402 wallet balance` reads the chain over JSON-RPC, so it answers on every backend, including one whose `signer check` reports `balances: false`. It exits `46` on a zero token balance and never on a zero gas balance. What a backend cannot do is the engine's _pre-flight_ funding check, which it skips rather than guessing — so a call can still fail at the provider for want of funds even where `signer check` looked fine.
- **A policy refusal is a decision, not an outage.** Exit `42` means OWS evaluated a policy and said no — to a token contract or a chain the wallet is not allowed to sign for. Retrying is pointless and `--no-cache` will not help. Report what the message names and stop. Note the policy bounds _what_ may be signed, not _how much_: an amount over budget is exit `44`, not `42`.
- **A token this CLI does not know is refused, not priced.** Exit `40`. The decimals and the EIP-712 domain of an unknown contract would have to come from the seller, and `--max` is compared in atomic units scaled by those decimals — a 402 declaring 18 decimals for a 6-decimal token would get a cap a trillion times too large. So the table decides, a payload that disagrees is refused, and USDC on Base is what this CLI pays with today.
- **`local` needs `ethers` and refuses loose file permissions.** It is the only backend that signs in-process, and `ethers` is an optional peer dependency, so a default install carries no signing code at all. Missing it is exit `47`, and the message says how to install it next to this CLI (`npx -p @roundhouseai/x402 -p ethers rh-x402 ...`, or `npm i @roundhouseai/x402 ethers` in a project). It also refuses a group- or world-readable keystore and a world-readable key file — those refusals are the point, so do not `chmod` around them. `local` is for development and CI; it has no policy layer.
