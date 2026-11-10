---
'@roundhouseai/x402': minor
---

Pay x402 `upto` quotes on EVM, alongside `exact`.

- `upto` signs a Permit2 witness transfer for the quoted ceiling, and the provider settles what the work actually cost. It is ported from the reference client in `@x402/evm` and checked against it in `test/upto.test.ts`. The spender is a constant (the x402 upto proxy), never read from the quote, so a quote cannot redirect the funds. The quote must carry `extra.facilitatorAddress`, or nothing is signed.
- A wallet that has not approved Permit2 for the token also signs an EIP-2612 permit for the facilitator to submit first, when the quote declares `eip2612GasSponsoring`. Deciding that reads `allowance` and the permit `nonces` over `rpc.<chain>` (two read-only `eth_call`s). If the allowance read fails the permit is still signed; if the nonce read fails nothing is signed. This is the one place an EVM payment calls an RPC (`docs/spec-deviations.md` §16).
- Selection prefers `upto` when a provider offers both schemes, since its amount is a ceiling the provider settles under and an `exact` amount is taken whole. `--scheme exact|upto` forces one. `upto` is never chosen from a v1 quote.
- `--max`, the per-call cap and the daily cap compare against the ceiling, so a call that settles for less still counts at the ceiling.
- OWS policies do not allow Permit2 by default, because OWS cannot narrow that to a token or spender. Pass `--allow-permit2` to `setup`, `wallet create --policy` or `wallet policy` to allow it. An existing policy without it makes OWS refuse the `upto` signature; use `--scheme exact` or recreate the policy.
- The authorization cache key now includes the scheme for `upto`. Existing `exact` entries still hit.
