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

## Three ways to hold a key

`rh-x402 wallet create` is the guided version of this whole section: it asks how the key should be held, installs the OWS bindings if you pick that and they are missing, creates the wallet, writes the config, and prints the address to fund.

```bash
rh-x402 wallet create                                             # asks
rh-x402 wallet create --path ows --name my-agent --install        # or don't
rh-x402 wallet create --path import --name dev --key-file ./k.hex
```

It never installs anything without being asked (a prompt, or `--install`), never creates over an existing OWS wallet — it adopts it and says so — and never takes a passphrase as a flag, because a flag lands in argv and in shell history. Non-interactively, an unanswerable question is an error, not a hang: `--path` is required when there is no terminal.

|                         | Where the key lives   | Needs                        | Does this CLI ever hold the key?           |
| ----------------------- | --------------------- | ---------------------------- | ------------------------------------------ |
| **OWS** _(recommended)_ | An OWS vault          | `@open-wallet-standard/core` | **No** — one payload in, one signature out |
| **Import**              | An encrypted keystore | `ethers`                     | Yes — decrypted in this process to sign    |
| **Generate**            | An encrypted keystore | `ethers`                     | Yes — same, and the key is made here       |

**Prefer OWS, and be clear about why.** The reason is custody, not policy: the key stays in the OWS vault and this CLI never receives it, so a bug or a compromise here cannot leak the key itself. Both keystore paths decrypt the key into this process on every signature.

**A binding spend policy is a fourth thing, and none of the three give it to you.** OWS describes its policy engine as gating _agent (API key)_ operations, and `createApiKey(name, walletIds, policyIds, …)` is what binds a policy to a caller — `signTypedData` takes no key or policy argument, so an in-process call authenticated by the vault passphrase has nothing to bind one to. That is why `ows-core` declares `policies: false`. If you want a limit that holds even when this CLI misbehaves:

```bash
ows policy create --file ./policy.json
ows key create --name x402-agent --wallet my-agent --policy <id>
rh-x402 config set wallet.backend ows   # the HTTP backend authenticates with that key
```

Otherwise `limits.maxPerCall` and `limits.dailyCap` are the only caps you have, and they are computed from a local ledger — they stop mistakes, not an attacker.

### Generating a key here

```bash
export X402_KEYSTORE_PASS='…'
rh-x402 signer keystore generate dev
```

The key is generated in process, written straight to the encrypted keystore, and never printed — there is deliberately no way to read it back out. Not recommended for a funded wallet, and the command says so on stderr every time.

One caveat worth stating plainly, because it undercuts the reason you might reach for this: generating a key does _not_ avoid a dependency. Node's crypto can make a secp256k1 key (`createECDH`), but it has no keccak256 — `sha3-256` is the NIST variant, with different padding, and is not interchangeable — so deriving the Ethereum address still needs `ethers`, and so does signing. If you are installing `ethers` either way, prefer bringing a key you already control.

## Choosing one

```bash
rh-x402 signer list                   # what is available, and what is active
rh-x402 signer check                  # resolve the active backend and report its capabilities
rh-x402 signer check local            # check a specific one
rh-x402 call <url> --signer local     # per call
```

Per-project in `.x402rc`, or globally:

```bash
rh-x402 config set wallet.backend ows
rh-x402 config set wallet.default my-agent
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

**The open question, answered.** EIP-3009 requires EIP-712 typed-data signing: the digest is `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))` over a typed structure, not an arbitrary string. This repo's longest-standing blocker was that the published OWS core types showed `signMessage` with `utf8`/`hex` only, neither of which can produce that signature.

`@open-wallet-standard/core@1.4.2` **does** export `signTypedData`. It was checked the only way worth trusting — by signing a real `TransferWithAuthorization` payload with it and inspecting the result: 65 bytes, `v` appended, recovery id 27/28. That is what the `ows-core` backend below is built on.

What that settles and what it does not: the _capability_ exists in OWS, so EIP-3009 over OWS is no longer hypothetical. The HTTP daemon's `POST /v1/wallets/:wallet/sign-typed-data` route has **not** been exercised against a running OWS, so the `ows` backend still assumes typed-data support (`declared: false`) and surfaces a missing method as exit `47`. If you want OWS today, `ows-core` is the path that is known to work.

Error mapping (`mapOwsError`):

| OWS response                               | Exit code                          |
| ------------------------------------------ | ---------------------------------- |
| Insufficient funds/balance                 | 46 `insufficient_balance`          |
| 403, or a policy/denied/limit message      | 42 `policy_denied`                 |
| 401/407, or an auth/api-key message        | 47 `ows_unavailable`               |
| 404/405/501                                | 47, pointing at typed-data support |
| Connection refused, timeout, anything else | 47 `ows_unavailable`               |

## `ows-core` — OWS in process, no daemon

The same vault as `ows`, loaded directly through the [`@open-wallet-standard/core`](https://www.npmjs.com/package/@open-wallet-standard/core) native bindings instead of over HTTP. There is no service to start, and the key still never leaves OWS: the engine hands over one EIP-712 payload and gets a signature back.

```bash
rh-x402 wallet create --path ows --install   # installs, creates, configures
rh-x402 signer check
```

Or by hand:

```bash
npm i @open-wallet-standard/core
rh-x402 config set wallet.backend ows-core
rh-x402 config set wallet.default my-agent
```

```json
"backends": { "ows-core": { "vaultPath": "~/.ows/vault", "passphrase": "env:OWS_VAULT_PASS" } }
```

Both keys are optional: omit `vaultPath` and OWS uses its own default location; omit `passphrase` and it prompts or uses an unlocked vault, per your OWS setup.

| Capability  | Value   | Why                                                                                     |
| ----------- | ------- | --------------------------------------------------------------------------------------- |
| `typedData` | `true`  | Verified against the package, not assumed — see above                                   |
| `policies`  | `false` | Policies gate API-key callers; in-process signing has no key to bind one to — see above |
| `balances`  | `false` | The package exports no balance function, so the pre-flight funding check is skipped     |
| `accounts`  | `true`  | `listWallets` / `getWallet`                                                             |
| `declared`  | `true`  | These come from the package's own API surface                                           |

`balances: false` is worth reading twice: **`rh-x402 wallet balance` is not universal.** Only the HTTP `ows` backend can answer it; `ows-core` and `local` cannot, and `local` says so in as many words. A funding check has to read the token contract directly rather than asking the signer.

Two details the backend handles, both found by running the package rather than reading its types:

- The bindings return a 65-byte signature **without** a `0x` prefix. Passed through unchanged it produces an `X-PAYMENT` header no facilitator will accept, so it is normalised at the backend boundary. A result that is not 65 bytes is an error, not something to pay with.
- OWS names EVM chains (`base`, `base-sepolia`), not CAIP-2. Chain ids are mapped through `core/assets.ts` so the rest of the tool keeps its own vocabulary.

Failures map the usual way: a policy refusal is exit `42` and must not be retried; anything else — locked vault, unknown wallet, a wallet with no EVM account, the package not installed — is exit `47`.

`@open-wallet-standard/core` is an **optional** peer dependency, exactly like `ethers`, so a default install still carries no signing code. It ships prebuilt bindings for macOS and Linux on x64 and arm64 only.

## `local` — development and CI only

An encrypted keystore: scrypt (N=16384, r=8, p=1) stretches the passphrase, AES-256-GCM seals the key. The file is `0600`, and loading refuses a group- or world-readable file.

```bash
export X402_KEYSTORE_PASS='…'
rh-x402 signer keystore add dev --key-file ./testnet.key   # never from argv
rh-x402 signer keystore generate dev                        # or make one; not recommended
rh-x402 signer keystore list
rh-x402 call <url> --signer local --wallet dev
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
rh-x402 config set wallet.backend acme
rh-x402 config set wallet.backends.acme.region eu-west-1
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
