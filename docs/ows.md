# The OWS integration

All production signing goes through an [Open Wallet Standard](https://github.com/open-wallet-standard) agent access layer. The CLI holds an OWS API key scoped to one wallet, with policies attached on the OWS side. There is no fallback signing path: if OWS denies, the call fails.

## The blocking question

**EIP-3009 requires EIP-712 typed-data signing.** The published OWS core types show `signMessage` with `utf8`/`hex` encodings only. Neither can produce a `transferWithAuthorization` signature: the digest is `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))` over a typed structure, not an arbitrary string, and a wallet that signs opaque bytes cannot show the user what they are authorising — which is the whole point of EIP-712 for payments.

If OWS does not expose typed-data signing, this tool cannot exist in its intended form. That is an upstream issue to settle, not something to work around here. Tracked as an issue and in [`roadmap.md`](roadmap.md).

## What this client expects

`src/core/ows.ts` speaks a small HTTP surface against `wallet.owsEndpoint`, with `Authorization: Bearer <wallet.apiKey>`:

| Method | Path                                        | Used by                                              |
| ------ | ------------------------------------------- | ---------------------------------------------------- |
| `GET`  | `/v1/wallets`                               | `x402 wallet list`, health checks                    |
| `GET`  | `/v1/wallets/:wallet`                       | address resolution (the `from` in the authorization) |
| `GET`  | `/v1/wallets/:wallet/balance?asset=&chain=` | the pre-flight balance check (exit 46)               |
| `POST` | `/v1/wallets/:wallet/sign-typed-data`       | **the load-bearing call**                            |

The signing request sends `{ "typedData": { types, primaryType, domain, message } }` and expects `{ "signature": "0x…" }`. `types` includes `EIP712Domain`, as wallets implementing `eth_signTypedData_v4` expect.

Responses are read tolerantly (`signature` / `result` / `data`; `amount` / `balance` / `value`) because the endpoint shape is not yet fixed. Once OWS publishes its agent-access API, this module should be narrowed to it.

## Error mapping

OWS failures are mapped onto the CLI's taxonomy in `mapOwsError()`:

| OWS response                                   | Exit code                                         |
| ---------------------------------------------- | ------------------------------------------------- |
| Anything mentioning insufficient funds/balance | 46 `insufficient_balance`                         |
| 403, or a policy/denied/limit message          | 42 `policy_denied`                                |
| 401/407, or an auth/api-key message            | 47 `ows_unavailable`                              |
| 404/405/501                                    | 47, with a message pointing at typed-data support |
| Connection refused, timeout, anything else     | 47 `ows_unavailable`                              |

The distinction matters to callers: 42 means a human must widen a policy; 47 means the wallet layer is down and a retry might work.

## The development escape hatch

`--unsafe-private-key-file <path>` exists for local development against a testnet. It:

- reads the key from a file, never from argv or an environment variable;
- prints a warning to stderr on **every** use;
- refuses a world-readable file, and warns on a group-readable one;
- needs the optional peer dependency `ethers` — a default install of this CLI contains no signing code at all.

It is not a production path, and there is no flag that turns it into one. If you find yourself wanting it in production, the answer is an OWS policy, not this flag.

## Wallet policies

Mirror your CLI caps as OWS policies. `limits.maxPerCall` and `limits.dailyCap` are fail-fast conveniences computed from a local ledger that a compromised or buggy caller could ignore or delete; the OWS policy is the control that actually binds. A sensible starting set:

- per-signature maximum matching `limits.maxPerCall`
- daily total matching `limits.dailyCap`
- recipient allowlist matching `allowlist.payTo`, if you keep one
- contract allowlist limited to the USDC contracts you intend to pay in
