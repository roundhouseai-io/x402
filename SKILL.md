---
name: x402
description: Pay for HTTP APIs with x402. Use when a request returns HTTP 402, when an API needs per-call payment, when you need the price of a paid endpoint before calling it, or when you need to find the cheapest provider of a capability. Covers the x402 CLI and the local unified endpoint.
---

# x402

Three flows, two surfaces, one failure taxonomy.

| Flow       | Question it answers                                                 |
| ---------- | ------------------------------------------------------------------- |
| `probe`    | What does this cost? (never pays)                                   |
| `call`     | Get me the data (pays if a price is quoted and the limits allow it) |
| `discover` | Who sells this capability cheapest?                                 |

**Surfaces.** The CLI (`x402 …`) and the local unified endpoint (`http://127.0.0.1:8403`, started with `x402 serve`). They share one wallet, one set of spend gates, one ledger and one set of error codes. Use the CLI if you can run commands; use the endpoint if you cannot.

**Money is real.** Every `call` may spend from a live wallet. Always pass a per-call cap you are willing to pay. When you do not know the price, `probe` first.

## 1. probe — what does this cost?

CLI:

```bash
x402 probe https://api.example.com/v1/lei
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
x402 call https://api.example.com/v1/lei --data.query "Amplify Limited" --max 0.01
```

Endpoint:

```bash
curl -s -X POST http://127.0.0.1:8403/v1/call \
  -H "Authorization: Bearer $X402_TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: lei-amplify-limited-1' \
  -d '{"url":"https://api.example.com/v1/lei","method":"GET","data":{"query":"Amplify Limited"},"max":"0.01"}'
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

The response body you want is `body`. `paid` tells you whether money moved; `amount` is what it cost; `receiptId` is what you quote if you need to verify settlement later (`x402 verify <receiptId>`).

**Passing data.** `--data.<path> <value>` builds nested JSON: dots for objects, `[n]` for arrays.

```bash
x402 call https://api.example.com/v1/screen \
  --data.company.name "Amplify Limited" \
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
x402 discover lei
x402 call x402:lei --data.query "Amplify Limited" --max 0.01
```

Endpoint:

```bash
curl -s -H "Authorization: Bearer $X402_TOKEN" \
  'http://127.0.0.1:8403/v1/discover?capability=lei'
```

```json
{
  "ok": true,
  "capability": "lei",
  "count": 2,
  "providers": [{ "url": "https://provider.example/v1/lei", "price": "0.002", "asset": "usdc" }]
}
```

A capability URI (`x402:lei`) can be used anywhere a URL can. It resolves through configured pins first, then the index, picking the cheapest allowed provider. The provider actually used appears in the response envelope, so prefer capabilities over hard-coded vendor URLs.

## Exit codes

The CLI exits with these; the endpoint returns the same number as `errorCode` (and MCP as `errorCode` inside the tool result). Branch on the number, not the message.

| Code | Meaning                                  | What to do                                                                                                                |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success (paid or free)                   | Use `body`                                                                                                                |
| 1    | Generic / network error                  | Safe to retry; nothing was paid                                                                                           |
| 40   | Invalid 402 payload (not x402-compliant) | Do not retry; report the endpoint                                                                                         |
| 42   | Denied by OWS policy                     | Do not retry; a human must widen the wallet policy                                                                        |
| 43   | Denied by payTo/domain allowlist         | Do not retry; provider is not approved                                                                                    |
| 44   | Price exceeds your `--max`               | Re-`probe`; raise `--max` only if a human authorised it                                                                   |
| 45   | Session budget or daily cap exhausted    | Stop spending; report it                                                                                                  |
| 46   | Insufficient wallet balance              | Stop; the wallet needs funding                                                                                            |
| 47   | OWS unreachable or auth failed           | Retry once, then report the wallet layer as down                                                                          |
| 50   | Payment sent, but no valid response      | **Money may have moved.** Re-run the identical command (it reuses the cached authorization). Never add `--no-cache` here. |

## Do and do not

- **Do** pass `--max` on every call, and `probe` when you do not know the price.
- **Do** re-run the identical command after a transient failure; that is what makes retries safe.
- **Do** use `x402:<capability>` rather than pinning a vendor URL, unless determinism matters more than price.
- **Do not** add `--no-cache` to work around an error — it is the double-payment path.
- **Do not** ask for or handle private keys. Signing belongs to the wallet layer; there is no key flag.
- **Do not** turn on `--telemetry-payload full` for calls carrying personal data; the default (`hash`) exists for that reason.
- **Do not** treat exit 42/43/45/46 as retryable. They need a human decision.
