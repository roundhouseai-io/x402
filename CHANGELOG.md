# @roundhouseai/x402

## 0.1.2

### Patch Changes

- 99fc914: Stop `config set` accepting keys that do nothing, and point a stuck agent at `wallet create`.

  All four of these come from watching an agent try to set up a wallet unaided and fail in ways that were the CLI's fault, not its own.

  - **`config set` accepted any dotted key and reported success.** `rh-x402 config set signer.backend local` — the wrong key; the real one is `wallet.backend` — returned `ok: true`, wrote a branch nothing reads, and left every later command using the default backend while `config.json` looked configured. Unknown keys are now refused, with the nearest match named: `unknown config key "signer.backend". Did you mean wallet.backend, wallet.backends?`. Backend and pin subtrees stay open, since a third-party `x402-signer-<name>` may need keys this package cannot know.
  - **`config unset <key>` is new.** There was no way to remove a key without hand-editing `config.json`, so a mistaken `set` was unfixable through the CLI. It prunes objects it empties, and deliberately skips validation so keys written before this check can still be removed.
  - **"no wallet selected" now names `rh-x402 wallet create`.** Without that pointer an agent reads the message as an invitation to assemble a wallet by hand out of `npm i ethers`, `signer keystore generate` and `config set`, which is exactly what the guided command exists to prevent.
  - **The docs no longer imply an OWS daemon exists.** `@open-wallet-standard/core` ships no `serve` or `daemon` command, so an agent told to point at `http://127.0.0.1:8402` goes looking for a service to start and finds nothing. Both README and `docs/signers.md` now say plainly that the HTTP backend is for a separate OWS service you already run, and that `ows-core` is the in-process path.

  Note for anyone scripting against this: a `config set` of a key that never did anything now fails instead of silently succeeding. That is the fix, but it is a behaviour change.

- 7286ff8: Point people at the backend that needs no daemon, and show which config values nobody chose.

  From a second round of agent testing against a real OWS wallet, where the whole session was spent hunting a daemon that does not exist.

  - **"OWS unreachable at 127.0.0.1:8402" now names the fix.** On a loopback endpoint it adds: nothing is listening, `@open-wallet-standard/core` ships no daemon, so switch to `ows-core`, which talks to the same vault in process. Previously the message read as a service that had failed to start, and the reasonable response was to go looking for it — `ows --help | grep daemon`, `ps aux | grep ows`, both empty. Remote endpoints are left alone, since a service there may genuinely be down.
  - **`config list` distinguishes a default from a choice.** JSON output carries an `origins` map (`default` | `user` | `project` | `flag`) per key; terminal output lists which keys are showing defaults. `wallet.backend: "ows"` printed identically whether or not anyone set it, which is how an untouched default came to look like it was overriding something.
  - **`signer keystore add` and `generate` prompt for a passphrase on a terminal**, the way `wallet create` already does, instead of requiring `X402_KEYSTORE_PASS` and only saying so after failing.
  - **`--help` names the exec protocol doc** (`docs/exec-signer.md`), which existed and was hard to find from the CLI.

- 3f3ccd6: Never delete an OWS wallet; hide it instead.

  - **`rh-x402 wallet forget <name>`** removes a wallet from this CLI's view by writing the name to `wallet.hidden` and clearing `wallet.default` if it pointed there. **The backend is untouched** — an OWS wallet keeps its funds, still appears in `ows wallet list`, and comes back with `rh-x402 wallet restore <name>`. `wallet list` reports how many are hidden, so a hidden wallet is not silently invisible.
  - **The destructive OWS bindings are unreachable, not merely unused.** `@open-wallet-standard/core` exposes `deleteWallet`, `exportWallet` and `renameWallet`; none is declared on `OwsCoreModule`, and `test/owssafety.test.ts` fails the build if any is referenced from `src/`. A wallet holds money, so a tool that can spend from it should not also be able to destroy it — and `exportWallet` would pull a secret out of the vault, which the no-raw-private-keys rule already forbids. Recorded as an invariant in `CLAUDE.md`.
  - **New config key `wallet.hidden`.**

## 0.1.1

### Patch Changes

- 33fba09: Add `rh-x402 wallet create`, a guided wallet setup, and correct the `ows-core` policy claim.

  - **`rh-x402 wallet create`** asks how the key should be held (OWS, import a key file, or generate one), installs `@open-wallet-standard/core` if you pick OWS and it is missing, creates the wallet, writes the config, and prints the address to fund. It installs nothing without a prompt or `--install`, adopts an existing OWS wallet rather than creating over it, and never takes a passphrase as a flag. Without a terminal it needs `--path` and errors rather than hanging on an unanswerable question.
  - **The install targets the `node_modules` that owns this package**, not the shell's cwd. `loadOwsCore` imports from this module's location, so a plain `npm i` in the wrong directory would appear to succeed and still fail to load — for a globally installed CLI it now uses `-g`, and for a project install a `--prefix`.
  - **`ows-core` no longer claims a policy layer it does not have when signing with the vault passphrase.** OWS gates policies on _API-key_ callers — `createApiKey(name, walletIds, policyIds, …)` is what binds one — and a passphrase is owner access with nothing to bind a policy to. See the policy-gate entry below for what signing with an API key changes.
  - **A wrong or missing vault passphrase is explained rather than reported as `decryption failed: aead::Error`.** This one hid well: the address resolves without the passphrase, so `signer check` passes and the first _payment_ is what fails. Setup now also records the `env:OWS_VAULT_PASS` indirection whenever the vault has a passphrase, and says to export it.

- 871832e: Add the `ows-core` signer backend, drop the `x402` bin, and make the three ways to hold a key explicit.

  - **`ows-core`** signs through the `@open-wallet-standard/core` bindings in process, with no OWS daemon to run. It resolves this repo's longest-standing open question: the package does export `signTypedData`, verified by signing a real `TransferWithAuthorization` payload. It declares `balances: false` — the package exports no balance function, so the pre-flight funding check is skipped rather than guessed at.
  - **`@open-wallet-standard/core` is a new optional peer dependency**, alongside `ethers`. A default install still carries no signing code and no runtime dependencies.
  - **`rh-x402 signer keystore generate <name>`** creates a key in process and writes it straight to the encrypted keystore. It is never printed and cannot be read back. Not recommended for a funded wallet, and it warns on stderr.
  - **Breaking for global installs: the `x402` bin is gone**, leaving `rh-x402`. The unscoped `x402` name on npm belongs to another project, and shipping that bin name invited a collision. `npx @roundhouseai/x402` is unaffected.

- a8e1170: Make the OWS policy gate actually bind, and add `rh-x402 wallet policy`.

  `ows-core` signed with the vault passphrase, which is owner access: OWS gates policies on API-key callers, so nothing constrained what the CLI could sign. It now signs with an OWS API key when one is configured, which puts the policy engine in front of every signature.

  - **`rh-x402 wallet policy`** registers a policy built from this CLI's own chain and asset tables — may sign EIP-3009 transfers of known USDC contracts, on the chains you name, and nothing else — mints an OWS API key bound to it, and points the backend at that key. `wallet create` offers the same thing during setup. A refused contract or chain is exit `42` from inside OWS, before the key is decrypted.
  - **`capabilities().policies` now reflects the configured credential**, so `signer check` says `true` only when a signature genuinely cannot bypass a policy.
  - **`requireApiKey` closes a silent downgrade.** `env:` indirections resolve to `undefined` when unset, so a shell that never exported the token would have fallen back to the passphrase — payments still working, policy quietly gone. That is now exit `47` with an explicit refusal instead.
  - **A policy cannot cap an amount.** OWS's rules are chains, typed-data contracts and expiry; there is no value limit. `limits.maxPerCall` and `limits.dailyCap` remain the only amount controls and remain advisory. The docs say so rather than implying a policy covers it.

- 737bacb: Install as `rh-x402`, and correct four things the docs got wrong.

  - **The binary is now `rh-x402`.** The unscoped `x402` package on npm is a different project that ships its own `x402` binary, so on a machine with both the short name was a coin toss. `rh-x402` is unique to this package. (This shipped first as an alias alongside `x402`; the `x402` bin is dropped in the same release — see below.)
  - **README and SKILL.md now lead with `discover`**, which needs no wallet, key or config: `discover.indexUrl` and `discover.unifiedUrl` ship pointing at the Roundhouse index, so it reads the live Unified Services layer immediately and gives you the market — min, median, spot, spread — before anything is spent.

  Four corrections, each found by driving the published package against production rather than reading the source, and each one that could have cost money as a wrong instruction:

  - **The README recommended the double-payment path.** Its exit-50 row said "investigate before retrying with `--no-cache`", directly contradicting `SKILL.md`'s "never add `--no-cache` here". After a 50 the correct move is re-running the _identical_ command so the cached authorization is reused; `--no-cache` there pays twice. Fixed, and the `--no-cache` example is now labelled as the deliberate re-pay path.
  - **Exit 47 means two different things** and the docs only described one. A backend that is unreachable is retryable; a backend that is _incapable_ — `cannot report balances`, `needs the optional peer dependency ethers` — never is. `docs/exit-codes.md` said to "treat the wallet layer as down", which is wrong for half the cases.
  - **`wallet balance` is not universal.** It is a per-backend capability; `local` does not have it and exits 47, which reads like an outage. An unavailable balance is not a zero balance — the engine skips the pre-flight check rather than guessing, so where a backend cannot answer, read the token contract directly.
  - **The `local` backend needs `ethers`** (an optional peer dependency, so a default install carries no signing code at all) and refuses a group- or world-readable keystore or a world-readable key file. Neither was in the README.

  Also guards the release workflow against the mis-tag that shipped v0.1.0: it now fails loudly if the tag for the version being published already exists at a different commit, rather than publishing against a tag that describes different code.

## 0.1.0

### Minor Changes

- 6816490: First release. One command for the whole x402 payment loop.

  - Signing goes through a pluggable **signer backend**, so the tool is wallet-agnostic: `ows` (the reference backend, API-key auth and policy-gated signing), `local` (an encrypted scrypt + AES-256-GCM keystore, development and CI only, warning on every signature), `exec` (any executable speaking JSON over stdio), and third-party backends auto-discovered as `x402-signer-<name>`. A backend receives one EIP-712 payload and nothing else, and one that cannot sign typed data fails when the signer is resolved rather than mid-payment.
  - `call` runs the full loop: request, 402, spend gates, EIP-3009 authorization signed via OWS, retry with `X-PAYMENT`, receipt. `probe` reports the price without paying; `pay` builds a header from a 402 payload; `verify` confirms settlement; `wallet`, `history`, `discover` and `config` round out the surface.
  - Dot-path data flags (`--data.company.name`), `--json` (inline, `@file` or stdin), type coercion with `str:` and `--data-strings`, and the GET-to-query-params placement rules.
  - Spend gates in a fixed order — domain and payTo allowlists, `--max`, `--budget`, `limits.dailyCap` — each with its own stable exit code, all checked before anything is signed.
  - Signed authorizations are cached and reused, so a retry after a lost response does not pay twice.
  - An append-only local ledger with `none`/`hash`/`full` payload levels (`hash` by default), always-redacted auth headers, and an optional batched remote sink with a local outbox.
  - `serve` exposes the same engine over HTTP with hashed caller tokens, per-token daily and per-call budgets, capability scoping and `Idempotency-Key` replay; `serve --mcp` exposes it as four MCP tools.
  - `x402 signer list|check` inspects backends and their capabilities; `x402 signer keystore add|list` manages the development keystore.
  - Stable exit codes (0, 1, 40, 42–47, 50) surfaced identically on the CLI, HTTP and MCP surfaces.

- 2809146: Point capability discovery at the Roundhouse index.

  - `discover.indexUrl` now defaults to `https://www.roundhouse.studio/api/v0`, queried as `GET <indexUrl>/endpoints?q=<capability>`. The index's `endpoints` payload is mapped onto providers (`resource` → url, `service_name` → capability, `price_usdc` → price, `pay_to` → payTo, `l30_total_calls` → calls30d, `l30_unique_payers` → payers30d, `is_live` → live); the previous `providers`/`results`/bare-array and camelCase shapes are still read.
  - The index states the chain as CAIP-2 (`eip155:8453`) and the asset as a contract address. Both are resolved through `core/assets.ts` to the names the 402 parser already produces (`base`, `usdc`), so `defaults.chain` and the allowlists compare like with like; an unrecognised network or asset passes through verbatim.
  - Providers sort live-first, then cheapest. `x402 discover` marks a down provider `[down]`; resolving `x402:<capability>` for a call skips down providers entirely rather than routing a payment to an endpoint the index last saw unreachable, and says how many allowed providers are down when none can be used.
  - The telemetry sink example and its bearer token are `https://www.roundhouse.studio/api/v0/ingest/x402` and `ROUNDHOUSE_INGEST_TOKEN`.
  - `x402 discover`, `GET /v1/discover` and the `x402_discover` MCP tool now report the capability's whole market, not just a list: `stats` carries `min`, `p25`, `median`, `p75`, `max`, `spread` (max / min) and `spot` (the average actually paid, call-weighted), plus offer/provider/live counts and the pricing `unit`. Discovery asks `unified.json?capability=<slug>` first because it is the only surface carrying them, and falls back to the `/endpoints?q=` keyword search — with `stats: null` — for anything it does not recognise. The new URL is the `discover.unifiedUrl` config key.
  - Providers gain `lastCalledAt`, `confidence` and `gateway` from the same document.
  - **The 402 parser reads x402 v2 headers.** v2 providers put the requirements in `Payment-Required` or `WWW-Authenticate: X402 requirements="…"`, base64-encoded, and leave a human-readable stub in the body. Previously every such endpoint failed with exit 40 (`unsupported or missing network in 402 payload: null`) — including BlockRun.AI and Otto AI, two of the most-used endpoints on the index. The header is now read first and treated as authoritative, since the body's price can be stale: BlockRun's body says `0.01` where its header says `0.011`.
