---
'@roundhouseai/x402': patch
---

Refuse a cross-origin redirect before a payment is signed or sent, require an explicit successful settlement with a transaction before `verify` reports one, cap an authorization window at five minutes, reject a zero-address payee, and scope `serve` idempotency keys to the caller token.
