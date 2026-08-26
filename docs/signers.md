# Signer backends

The payment engine never touches key material. It talks to a **signer backend** through a four-method interface, and anything that implements it can be the wallet. OWS is the reference backend, not a dependency.

```ts
interface SignerBackend {
  readonly backend: string; // 'ows', recorded in the ledger
  readonly wallet: string; // wallet id within that backend
  capabilities(): Promise<SignerCapabilities>; // { typedData, policies, balances, accounts, declared }
  getAccounts(): Promise<SignerAccount[]>; // [{ id, address, chains }]
  getAddress(chain?): Promise<string>;
  signTypedData(typedData): Promise<string>; // EIP-712, required
  getBalance?(asset, chain): Promise<SignerBalance | undefined>;
}
```

Four rules hold for every backend, and they are why the interface is this narrow:

1. **Signature-only.** A backend receives one EIP-712 payload and nothing else — no URL, no request body, no response body. A malicious or buggy backend cannot exfiltrate call content because it never sees any.
2. **Typed data or nothing.** A backend that _declares_ it cannot sign EIP-712 typed data is rejected when the signer is resolved (exit `47`), before any request is made — not mid-payment with an authorization half-built.
3. **Backends may refuse.** A policy refusal maps to exit `42`, which agents must not retry.
4. **No automatic fallback.** If the chosen backend denies or is unavailable, the call fails. There is no second backend to try, ever.

## Choosing one

```bash
x402 signer list                   # what is available, and what is active
x402 signer check                  # resolve the active backend and report its capabilities
x402 signer check local            # check a specific one
x402 call <url> --signer local     # per call
```

Per-project in `.x402rc`, or globally:

```bash
x402 config set wallet.backend ows
x402 config set wallet.default my-agent
```

## `ows` — the reference backend (default)

An [Open Wallet Standard](https://github.com/open-wallet-standard) agent access layer: API-key auth, policy-gated signing. The CLI holds a key scoped to one wallet; the policies live on the OWS side and are the binding spend control.

```json
"wallet": {
  "backend": "ows",
  "default": "my-agent",
  "backends": { "ows": { "endpoint": "http://127.0.0.1:8402", "apiKey": "env:OWS_API_KEY" } }
}
```

| Method            | HTTP call                                                         |
| ----------------- | ----------------------------------------------------------------- |
| `capabilities()`  | `GET /v1/capabilities` (optional; support is assumed when absent) |
| `getAccounts()`   | `GET /v1/wallets`                                                 |
| `getAddress()`    | `GET /v1/wallets/:wallet`                                         |
| `getBalance()`    | `GET /v1/wallets/:wallet/balance?asset=&chain=`                   |
| `signTypedData()` | `POST /v1/wallets/:wallet/sign-typed-data`                        |

**The open question.** EIP-3009 requires EIP-712 typed-data signing: the digest is `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))` over a typed structure, not an arbitrary string. The published OWS core types show `signMessage` with `utf8`/`hex` only, and neither can produce that signature — nor can a wallet that signs opaque bytes show a human or a policy engine _what_ is being authorised, which is the point of EIP-712 for payments.

Because OWS does not advertise capabilities yet, the backend assumes typed-data support (`declared: false`) and a missing method surfaces as exit `47` with a message that says so. The signer abstraction means this no longer blocks the CLI — `local` and `exec` can ship first — but it does block OWS as the flagship backend. Tracked as an issue.

Error mapping (`mapOwsError`):

| OWS response                               | Exit code                          |
| ------------------------------------------ | ---------------------------------- |
| Insufficient funds/balance                 | 46 `insufficient_balance`          |
| 403, or a policy/denied/limit message      | 42 `policy_denied`                 |
| 401/407, or an auth/api-key message        | 47 `ows_unavailable`               |
| 404/405/501                                | 47, pointing at typed-data support |
| Connection refused, timeout, anything else | 47 `ows_unavailable`               |

## `local` — development and CI only

An encrypted keystore: scrypt (N=16384, r=8, p=1) stretches the passphrase, AES-256-GCM seals the key. The file is `0600`, and loading refuses a group- or world-readable file.

```bash
export X402_KEYSTORE_PASS='…'
x402 signer keystore add dev --key-file ./testnet.key   # never from argv
x402 signer keystore list
x402 call <url> --signer local --wallet dev
```

```json
"backends": { "local": { "keystore": "~/.x402/keystore.json", "passphrase": "env:X402_KEYSTORE_PASS" } }
```

Every `local` signature prints a warning to stderr, for a reason worth being blunt about: **`local` has no policy layer.** The CLI-side caps (`--max`, `--budget`, `limits.dailyCap`) are the only spend control, and they are computed from a local ledger that a buggy caller could ignore. Use it against a testnet, in CI, and nowhere else.

`local` needs the optional peer dependency `ethers` for secp256k1 and the EIP-712 encoding (`npm i ethers`). A default install of this CLI therefore carries **no signing code at all** — which is the point.

## `exec` — any executable

The escape hatch that keeps this genuinely wallet-agnostic: a hardware wallet bridge, an MPC service, a KMS wrapper or a bespoke corporate signer is one small executable away, in any language, with no change to the CLI.

```json
"backends": { "exec": { "command": "/usr/local/bin/my-signer", "args": [], "timeoutMs": 30000 } }
```

One process per request, one JSON line in, one JSON line out; stderr passes through so a helper can talk to the operator. The protocol is in [`exec-signer.md`](exec-signer.md).

## Third-party backends

An unknown backend name is resolved as the npm package `x402-signer-<name>`, which must export `createSigner({ config, wallet })` returning a `SignerBackend`:

```bash
npm i x402-signer-acme
x402 config set wallet.backend acme
x402 config set wallet.backends.acme.region eu-west-1
```

An unknown name that is not installed fails with exit `47` naming the package it looked for.

## `awal` — candidate, v1.1

An adapter over Coinbase's Agentic Wallet CLI, for teams already on it. Not implemented: it can be an `exec` helper today, and the point of the abstraction is that adopting it costs the CLI nothing.

## Writing a backend

Implement the interface, keep these in mind:

- **Declare capabilities honestly.** `typedData: false` fails fast, which is the kind outcome. Setting `declared: true` means "I know what I can do".
- **Map your failures.** Policy refusal → exit `42`; unreachable, unauthenticated, or missing capability → exit `47`; insufficient funds → exit `46`. The taxonomy is what lets agents act without parsing prose.
- **Never widen the interface.** If you find yourself wanting the request URL, stop: that is the boundary doing its job.
- Balances are optional. Omit `getBalance` and the pre-flight check is skipped rather than guessed.

## Mirror your caps in the backend

`limits.maxPerCall` and `limits.dailyCap` are fail-fast conveniences computed from a local ledger. Where the backend has a policy layer, mirror them there — that is the control that actually binds:

- per-signature maximum matching `limits.maxPerCall`
- daily total matching `limits.dailyCap`
- recipient allowlist matching `allowlist.payTo`
- contract allowlist limited to the USDC contracts you intend to pay in
