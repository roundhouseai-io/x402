---
'@roundhouseai/x402': minor
---

Spend limits are on by default: `limits.maxPerCall` is `1.00` and `limits.dailyCap` is `5.00` (USDC) when you set none.

Before this, a fresh install had no cap, so a provider could quote any price in a 402 and the CLI would sign for it. Now a quote above 1.00 USDC exits `44` and one that would take the day past 5.00 USDC exits `45`, both before anything is signed.

- Raise them with `config set limits.maxPerCall <amount>`, `config set limits.dailyCap <amount>`, or `--max` for a single call.
- `status` reports which limits are the defaults (`limitsDefault`), and `set-caps` / `setup` still ask the operator to choose caps until they have written their own.
- Anything that paid more than 1.00 USDC per call, or more than 5.00 a day, without a configured cap will now fail until a higher cap is set.
