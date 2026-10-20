# Idempotency and the authorization cache

Double payment is the most likely agent failure mode: a request is signed, the provider settles it, the response is lost to a timeout, and the agent — being an agent — tries again. The authorization cache exists to make that retry free.

## How it works

When a call needs payment, the engine computes a cache key from the **request identity**:

```
sha256(METHOD | url | sha256(body) | payTo | amountAtomic | asset | chain | backend | wallet | x402Version)
```

`x402Version` is part of the identity because a v1 payload and a v2 payload are different documents travelling in different headers (`X-PAYMENT` vs `PAYMENT-SIGNATURE`): reusing one for the other guarantees a rejection.

If a live entry exists, its signature and payment header are reused and no signing happens. Otherwise the engine signs once and writes the entry to `~/.x402/authcache/<key>.json` (0600, in a 0700 directory) containing the signature, the typed data, the nonce, the encoded header and the authorization's `validBefore`.

Entries expire at their own `validBefore` — the EIP-3009 authorization is worthless afterwards. Expired entries are dropped on read and pruned opportunistically on every write.

Within one process (and inside `rh-x402 serve`), signing is serialised per engine: two concurrent identical calls produce one authorization, not two.

## Why the key omits `validBefore`

The spec (§5.1) lists `validBefore` in the key. It cannot be there: `validBefore` is computed at signing time, so a retry would compute a _new_ expiry, miss the cache and sign again — exactly the double payment the cache is meant to prevent. The expiry lives inside the entry instead, which produces the behaviour the spec describes. Recorded in [`spec-deviations.md`](spec-deviations.md).

## What invalidates an entry

- **Time.** Past `validBefore`, it is gone.
- **Any change to the request.** A different URL, method, body, price, asset, chain, wallet or protocol version is a different key — as it should be; those are different payments.
- **`--no-cache`.** Forces a fresh signature and does not write one. Use it when you _want_ to pay again.

### What does not invalidate an entry: a rejected authorization

A second 402 after paying fails the call with exit `40` and `paymentState: "signed"` — nothing settled, the wallet is untouched — and the entry is kept on purpose. A rejected authorization is still a live EIP-3009 signature until its `validBefore`, and the provider is holding it; signing a fresh one with a new nonce is the only way two transfers can happen. Reusing the entry keeps the worst case at one. Read the reason the provider gave (it is passed through verbatim in `error`) rather than retrying blindly.

## Retry rules

| Situation                                         | Do this                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Network error before the 402 was parsed (exit 1)  | Retry freely; nothing was signed                                                                  |
| Gate refusal (43, 44, 45, 46)                     | Do not retry; nothing was signed                                                                  |
| OWS refusal (42, 47)                              | Do not retry blindly; nothing was signed                                                          |
| Paid retry timed out or died (exit 50)            | Re-run the **identical** command. The cached authorization is reused.                             |
| Provider rejected the payment (exit 40, `signed`) | Nothing settled. Investigate the reason the provider gave; a retry reuses the same authorization. |

Never add `--no-cache` to "clear a stuck state" after a 50. That is the double-payment path.

## The unified endpoint

`rh-x402 serve` shares this cache, and adds request-level replay: send an `Idempotency-Key` header and a replay within the authorization's validity window returns the original receipt without touching the provider. The key is scoped to the caller token (or to the unauthenticated caller, when serve is open), so one token cannot replay another token's payment by reusing its key.

Response bodies are only replayable when `telemetry.payload` is `full` — at `hash` (the default) the body was never stored, so the replay returns the receipt with `bodyReplay: false`. That is the deliberate trade: not keeping a plaintext copy of every paid response beats being able to replay it.

## Inspecting the cache

```bash
ls -l ~/.x402/authcache/                     # one file per live authorization
jq '{payTo,amountAtomic,validBefore}' ~/.x402/authcache/*.json
```

Deleting a file is safe: the next identical call signs again (and pays again). Deleting the directory is safe for the same reason. Neither is something an agent should do.
