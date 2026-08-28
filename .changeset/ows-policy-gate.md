---
'@roundhouseai/x402': minor
---

Make the OWS policy gate actually bind, and add `rh-x402 wallet policy`.

`ows-core` signed with the vault passphrase, which is owner access: OWS gates policies on API-key callers, so nothing constrained what the CLI could sign. It now signs with an OWS API key when one is configured, which puts the policy engine in front of every signature.

- **`rh-x402 wallet policy`** registers a policy built from this CLI's own chain and asset tables — may sign EIP-3009 transfers of known USDC contracts, on the chains you name, and nothing else — mints an OWS API key bound to it, and points the backend at that key. `wallet create` offers the same thing during setup. A refused contract or chain is exit `42` from inside OWS, before the key is decrypted.
- **`capabilities().policies` now reflects the configured credential**, so `signer check` says `true` only when a signature genuinely cannot bypass a policy.
- **`requireApiKey` closes a silent downgrade.** `env:` indirections resolve to `undefined` when unset, so a shell that never exported the token would have fallen back to the passphrase — payments still working, policy quietly gone. That is now exit `47` with an explicit refusal instead.
- **A policy cannot cap an amount.** OWS's rules are chains, typed-data contracts and expiry; there is no value limit. `limits.maxPerCall` and `limits.dailyCap` remain the only amount controls and remain advisory. The docs say so rather than implying a policy covers it.
