---
'@roundhouseai/x402': minor
---

Speak x402 v2, report payment states honestly, and stop crashing on a numeric spend cap.

- **x402 v2 payments.** The protocol version now comes from the provider's own 402 and decides both the payload shape and the header: v1 signs into `X-PAYMENT`, v2 into `PAYMENT-SIGNATURE` with the v2 payload (the chosen requirements echoed under `accepted`, plus `resource` and `extensions`). Settlement is read from `PAYMENT-RESPONSE` as well as `X-PAYMENT-RESPONSE`. Every provider on the current index quotes v2 and rejects a v1 envelope, so `probe` reported `x402Version: 2` while `call` signed v1 and could not complete a single paid call. A version this build does not know now fails with exit `40` **before** anything is signed. The authorization cache key includes the version, so a v1 header is never replayed at a v2 provider.

- **`paymentState` in the envelope.** `none`, `signed`, `submitted` or `settled`, alongside `paid`. A call the provider rejected used to report `paid: true` beside a ledger amount of `0`; it now reports `paid: false`, `paymentState: "signed"` — nothing settled, the wallet is untouched. `paid` stays `submitted || settled` rather than settled-only, because `limits.dailyCap` counts `paid` records and most providers send no settlement receipt.

- **A spend cap written as a JSON number works.** `config set limits.maxPerCall 0.05` stored the number `0.05`, and reading it back threw `value.trim is not a function`, failing every `call`/`pay` without an explicit `--max`. Amounts are normalised to strings on write and on read, so a file an older build wrote behaves too.

- **The provider's own rejection message is passed through.** A second 402 now reports what the provider said — its settlement `errorReason`, the fresh 402's `error`, or its body — instead of a flat "provider rejected the payment authorization".

- **A saved 402 works everywhere.** `pay` accepts a base64 `PAYMENT-REQUIRED` value or a whole header line as well as JSON, and `call`/`probe` accept `@file` and `-` quotes, calling the resource URL the quote names. No more piping a header through `base64 -d` by hand.

- **The v2 payment headers are redacted from telemetry** (`PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, `PAYMENT-REQUIRED`), like their v1 spellings. A signed authorization is a bearer instrument.
