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
  "amount": "0.002",
  "asset": "usdc",
  "receiptId": "01J8ZK3M9Q…",
  "body": { "lei": "213800…" }
}
```

The response body you want is `body`. `paid` tells you whether money moved; `amount` is what it cost; `receiptId` is what you quote if you need to verify settlement later (`rh-x402 verify <receiptId>`).

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

- `--max 0.01` (CLI) or `"max": "0.01"` (endpoint) refuses anything pricier. Always set it.
- `--dry-run` reports the price and stops before signing. Use it when you are unsure.
- Repeat the _same_ command after a network failure: the signed authorization is cached and reused, so a retry does not pay twice. On the endpoint, send the same `Idempotency-Key`.
- `--budget 0.50` caps everything this process spends.

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
    "providers": 68,
    "live": 121
  },
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

`stats` is `null` when the capability is not a registered slug — the index then answers from a keyword search, which returns offers but no market-wide pricing. Figures are an indexed snapshot: always read the live 402 before paying.

A capability URI (`x402:web-search`) can be used anywhere a URL can. It resolves through configured pins first, then the index, picking the cheapest allowed provider the index reports as live. The provider actually used appears in the response envelope, so prefer capabilities over hard-coded vendor URLs.

## Exit codes

The CLI exits with these; the endpoint returns the same number as `errorCode` (and MCP as `errorCode` inside the tool result). Branch on the number, not the message.

| Code | Meaning                                                       | What to do                                                                                                                                                                                |
| ---- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success (paid or free)                                        | Use `body`                                                                                                                                                                                |
| 1    | Generic / network error                                       | Safe to retry; nothing was paid                                                                                                                                                           |
| 40   | Invalid 402 payload (not x402-compliant)                      | Do not retry; report the endpoint                                                                                                                                                         |
| 42   | Denied by OWS policy                                          | Do not retry; a human must widen the wallet policy. The message names what was refused — usually a token contract or chain outside the policy                                             |
| 43   | Denied by payTo/domain allowlist                              | Do not retry; provider is not approved                                                                                                                                                    |
| 44   | Price exceeds your `--max`                                    | Re-`probe`; raise `--max` only if a human authorised it                                                                                                                                   |
| 45   | Session budget or daily cap exhausted                         | Stop spending; report it                                                                                                                                                                  |
| 46   | Insufficient wallet balance                                   | Stop; the wallet needs funding                                                                                                                                                            |
| 47   | Signer backend unreachable **or unable to do what was asked** | Read the message. Unreachable/auth: retry once, then report the wallet layer as down. Incapable (`cannot report balances`, `needs the optional peer dependency ethers`): never retryable. |
| 50   | Payment sent, but no valid response                           | **Money may have moved.** Re-run the identical command (it reuses the cached authorization). Never add `--no-cache` here.                                                                 |

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

## Backend capabilities are not uniform

Run `rh-x402 signer check` before relying on anything beyond signing. Backends declare what they can do, and the two that bite:

- **Balances are optional.** `rh-x402 wallet balance` exits `47` with `the local backend cannot report balances` — the same code as an outage, which is why the message matters more than the code. The engine skips the pre-flight funding check rather than guessing, so a call can still fail at the provider for want of funds. Where the backend cannot answer, read the token contract directly instead of assuming.
- **A policy refusal is a decision, not an outage.** Exit `42` means OWS evaluated a policy and said no — to a token contract or a chain the wallet is not allowed to sign for. Retrying is pointless and `--no-cache` will not help. Report what the message names and stop. Note the policy bounds _what_ may be signed, not _how much_: an amount over budget is exit `44`, not `42`.
- **`local` needs `ethers` and refuses loose file permissions.** It is the only backend that signs in-process, and `ethers` is an optional peer dependency, so a default install carries no signing code at all. Missing it is exit `47` with `needs the optional peer dependency ethers (npm i ethers)`. It also refuses a group- or world-readable keystore and a world-readable key file — those refusals are the point, so do not `chmod` around them. `local` is for development and CI; it has no policy layer.
