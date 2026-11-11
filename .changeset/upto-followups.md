---
'@roundhouseai/x402': minor
---

Follow-ups to `upto` support, from a test of paying ioi.

- **The default `setup` policy is now wider.** `setup` and `setup --yes` create the OWS policy with Permit2 allowed, so the recommended setup can sign `upto`. OWS cannot narrow a contract-level rule to one token, spender or amount, so the wallet can now sign Permit2 documents for any token it has approved to Permit2. Chains and expiry stay bounded. Pass `--no-allow-permit2` to keep the old, narrower policy (an `exact`-only wallet). `wallet policy` and `wallet create --policy` are unchanged and still opt in with `--allow-permit2`. Existing wallets keep the policy they were made with: `upto` needs a new policy or `--scheme exact`.
- **The ledger and the daily cap count what was settled.** For `upto`, `amount` is what the provider's receipt reports, from `PAYMENT-RESPONSE` or from the final `x402_settlement` frame of a streamed response, and `ceiling` is what the signature allowed. With no usable figure the signed amount is counted, never less. Gates (`--max`, per-call cap, `--budget`, daily cap) still compare the ceiling.
- **New exit code 51, `settlement_failed`.** A provider that runs the request and then cannot settle answers 5xx with `error.code` `settlement_failed`. That is now `signed`, not paid, with the provider's message, instead of exit 50 ("paid, no response", whose advice is to re-run). Do not retry it unchanged. Exit codes are only appended.
- **`amount_too_low` is explained.** A payment rejected for it names the provider's code and message and the 0.001 USDC (1000 atomic unit) facilitator minimum. `probe` and `call --dry-run` add a `warnings` entry when a USDC quote is under that.
- **Provider `x-*` response headers** (price, venue, settlement transaction) are in the envelope under `response.headers`. Auth-like headers are never included.
