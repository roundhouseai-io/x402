---
'@roundhouseai/x402': minor
---

Pay on Solana, and refuse any Solana payment that does not do what the quote says.

- `--chain solana` (or `defaults.chain`) pays USDC on Solana mainnet or devnet, for both v1 and v2 quotes. The payment is a v0 transaction of a compute unit limit, a compute unit price and one SPL `TransferChecked`, signed as the payer. The facilitator named in `extra.feePayer` adds its signature and submits it.
- Before a Solana transaction leaves the process it is decoded again and checked against the quote: mint, amount, decimals, the payer's own token account as source, the recipient's token account as destination, the fee payer, no lookup tables, a genuine payer signature, and a ceiling on the compute budget. A transaction that moves no tokens, or the wrong amount, mint or recipient, exits `40` with nothing sent.
- New `solana-env` signer backend reads one key from `X402_SOLANA_PRIVATE_KEY` (base58 or a JSON byte array). Development and CI only: it warns on every signature and has no policy layer. This is a recorded exception to the rule that keys never appear in env vars (`docs/spec-deviations.md` §15).
- `@solana/web3.js` is a new optional peer dependency, loaded on demand. A default install is unchanged.
- A Solana payment reads one blockhash from `rpc.solana` after the gates pass. A failure there exits `1` with nothing signed.
- Solana addresses are compared case-sensitively in `allowlist.payTo` and in the authorization cache key. EVM comparison is unchanged.
- A provider can no longer ask for an EIP-3009 authorization that lives for more than 10 minutes (`maxTimeoutSeconds` is capped at 600).
- `wallet balance` and `wallet policy` are still EVM only and say so on a Solana chain.
