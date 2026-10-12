# @roundhouseai/x402

## 0.6.0

### Minor Changes

- c051d16: Faster agent setup, and telemetry on by default.

  - `rh-x402 setup --yes` now runs with no other flags. With no `--path` it holds the key in OWS, the custody this tool recommends. Without `--yes` and with no terminal, `--path` is still required.
  - The remote telemetry sink is on by default, sending to `https://api.roundhouseai.io/v0/telemetry` at the `hash` payload level (URLs, amounts, payees, timings and hashes; no request or response bodies). Opt out with `config set telemetry.sink.enabled false`, `DO_NOT_TRACK=1` or `X402_TELEMETRY=off`; the environment wins over config. The first batch prints a one-time notice on stderr. `setup` no longer asks about telemetry; `--telemetry off` still opts out.
  - Fixes `setup --telemetry on` sending nothing: it set `telemetry.sink.enabled` but no `telemetry.sink.url` existed to send to.

- bc5cfcb: Add `rh-x402 setup`: one command from nothing to a funded wallet, a proven payment path and a stored API key. Every answer has a flag, so it runs with no terminal (`--path`, `--max-per-call`, `--daily-cap`, `--telemetry`, `--org-key`, `--min-balance`, `--fund-timeout`, `--yes`). It is idempotent and resumable, skipping a step when `status` says it is done, and exits non-zero on the first failing step with that step's name and exit code. `--json` prints one object per step, `--dry-run` makes no wallet, config write or payment, and the API key is never printed unless `--print-key`. `status` now reports `signer.policyKey` and `spend.calls.total`.
- 3af2950: Smaller changes that the guided setup builds on.

  - `wallet balance --wait --min <usdc> --timeout <duration>` polls the chain until the wallet is funded. Exit `0` when met, new exit code `48` (`wait_timeout`) when it times out. `--min` alone checks once and exits `46` if short.
  - `config set auth.apiKey` stores a Roundhouse API key (an `env:NAME` reference, `-` for stdin, or a literal). It is sent as `Authorization: Bearer` to `roundhouseai.io` hosts only, and is redacted in `config get`, `config list` and `status`.
  - `discover --policy` applies the default counterparty rule (live, at least one payer in 30 days, price at or under 1.5 times spot) and lists the offers it excluded with the reason. `--spot-factor` changes the factor.
  - `rh-x402 help exit-codes` prints one table with a "what to do next" column (`--markdown`, `--json`). The help footer, `SKILL.md` and `docs/exit-codes.md` now draw on it.
  - The guided setup refuses to run `npm i -g` into a directory the user cannot write, and says to use `npx` or a project install, never `sudo`.
  - Importing `cli.ts` no longer runs the CLI.

### Patch Changes

- 7b41b7a: Fix the snags an agent hit setting up a wallet from `skill.md`.

  - `setup` and the changes it builds on (`wallet balance --wait`, `config set auth.apiKey`, `discover --policy`, `help exit-codes`) were merged into intermediate branches and never reached a release. They ship now, so `rh-x402 setup --daily-cap 5 ...` works as documented.
  - `wallet create --path import|generate` (and `setup` with those paths) checks for `X402_KEYSTORE_PASS` and the optional `ethers` peer before it asks for or writes anything, and reports both in one error. The message says how to install `ethers` next to the CLI, including `npx -p @roundhouseai/x402 -p ethers rh-x402 ...`.
  - `status` warns when a local keystore wallet has no passphrase or no `ethers` in this shell, so a missing passphrase shows before the first paid call rather than on it.
  - `config set` refuses a plain value on a group of settings. `config set telemetry on` used to replace the whole `telemetry` object, after which `status` threw `Cannot read properties of undefined (reading 'enabled')`. A config file already in that state now loads with an error that names the key and the fix, and `status` reports it instead of crashing.
  - `telemetry.sink.enabled` accepts `on`/`off`/`yes`/`no` and stores a boolean. `off` used to be stored as a string and read as on by the telemetry sink.

## 0.5.0

### Minor Changes

- f872697: Add `rh-x402 status`: a read-only report of where setup stands (CLI and Node version, signer, USDC balance, caps, API key set or unset, telemetry, today's spend) and `next`, the first step not yet done. `--json` prints one object, and the exit code is `0` only when `next` is `ready`. `wallet create` now records `wallet.path` so the custody choice is reported rather than inferred.

## 0.4.0

### Minor Changes

- c93a7dc: Speak x402 v2, report payment states honestly, and stop crashing on a numeric spend cap.

  - **x402 v2 payments.** The protocol version now comes from the provider's own 402 and decides both the payload shape and the header: v1 signs into `X-PAYMENT`, v2 into `PAYMENT-SIGNATURE` with the v2 payload (the chosen requirements echoed under `accepted`, plus `resource` and `extensions`). Settlement is read from `PAYMENT-RESPONSE` as well as `X-PAYMENT-RESPONSE`. Every provider on the current index quotes v2 and rejects a v1 envelope, so `probe` reported `x402Version: 2` while `call` signed v1 and could not complete a single paid call. A version this build does not know now fails with exit `40` **before** anything is signed. The authorization cache key includes the version, so a v1 header is never replayed at a v2 provider.

  - **`paymentState` in the envelope.** `none`, `signed`, `submitted` or `settled`, alongside `paid`. A call the provider rejected used to report `paid: true` beside a ledger amount of `0`; it now reports `paid: false`, `paymentState: "signed"` — nothing settled, the wallet is untouched. `paid` stays `submitted || settled` rather than settled-only, because `limits.dailyCap` counts `paid` records and most providers send no settlement receipt.

  - **A spend cap written as a JSON number works.** `config set limits.maxPerCall 0.05` stored the number `0.05`, and reading it back threw `value.trim is not a function`, failing every `call`/`pay` without an explicit `--max`. Amounts are normalised to strings on write and on read, so a file an older build wrote behaves too.

  - **The provider's own rejection message is passed through.** A second 402 now reports what the provider said — its settlement `errorReason`, the fresh 402's `error`, or its body — instead of a flat "provider rejected the payment authorization".

  - **A saved 402 works everywhere.** `pay` accepts a base64 `PAYMENT-REQUIRED` value or a whole header line as well as JSON, and `call`/`probe` accept `@file` and `-` quotes, calling the resource URL the quote names. No more piping a header through `base64 -d` by hand.

  - **The v2 payment headers are redacted from telemetry** (`PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, `PAYMENT-REQUIRED`), like their v1 spellings. A signed authorization is a bearer instrument.

## 0.3.0

### Minor Changes

- 7c2b831: Point discovery at the current Roundhouse API, and stop presenting a capped offer list as the whole market.

  - **New defaults.** `discover.indexUrl` is `https://api.roundhouseai.io/v0` and `discover.unifiedUrl` is `https://api.roundhouseai.io/v0/unified`. The capability document now takes the slug as a path segment (`/v0/unified/web-search`) rather than a query parameter, and answers `404` with a plain-text body for a slug it does not know — which the `/endpoints` fallback already handled.
  - **The pricing block moved.** The current document carries it at the top level with `spot_basis`; the retired `unified.json` nested it under `stats.price` with `spotBasis`. Both are read, and a `discover.unifiedUrl` still ending in `.json` is queried in the old form, so a pinned config degrades to nothing rather than to a stats-less market.
  - **`truncated` on every discovery surface** — CLI, HTTP and MCP. The index returns at most 50 offers per capability while `stats` describe every offer there is, so the cheapest listed is the cheapest that came back, not the cheapest that exists. It is derived from the counts rather than the document's own flag, which reads `false` on a capability that plainly capped the list (50 offers returned, `stats.offers: 137`).
  - **`stats.priced` / `stats.unpriced`**, so a caller can see how much of the market the quantiles actually describe.
  - The `/endpoints` keyword fallback now asks for an explicit `limit` instead of taking the API's default of 100.

## 0.2.0

### Minor Changes

- 049effe: Honour `HTTPS_PROXY`, ship `SKILL.md` through the CLI, and close two ways a call could hang or overspend.

  - **A price gate the counterparty can no longer rescale.** `--max` is compared in atomic units scaled by the asset's decimals, and those decimals were taken from the 402 payload. A provider quoting real 6-decimal USDC while declaring 18 got a cap 10^12 too large: `--max 0.05` would wave through a demand for fifty billion USDC while reporting that the gate held. Decimals now come from the asset table, a payload that disagrees is refused (exit `40`), and the EIP-712 domain comes from the table too — `extra` is the seller describing a contract it does not own.
  - **An unknown token contract is refused rather than priced on the seller's word** (exit `40`), naming what is known on that chain. Adding one is a table entry in `core/assets.ts` with the decimals and domain read from the contract.
  - **A piped stdin no longer hangs the CLI.** `spawn(cli, args, { stdio: 'pipe' })` — the ordinary way an agent runs a subprocess — opens stdin and never writes to it, and the read blocked forever: `rh-x402 probe <url>` never returned. The wait for the first byte is now bounded (500 ms, `X402_STDIN_WAIT_MS`), unbounded after an explicit `-`, and never applied once data has started, so a slow producer is not truncated.
  - **`HTTPS_PROXY` and `HTTP_PROXY` are honoured**, through a CONNECT tunnel built on Node's own `http`/`tls` — no dependency, and no `--use-env-proxy`, which needs Node 22. `NO_PROXY` is respected and loopback always bypasses, so a local OWS daemon is never asked for through a proxy.
  - **`rh-x402 skill` prints the agent-facing `SKILL.md`**, and `--help` now carries worked examples and the exit-code table.
  - **Ethereum mainnet is readable but not payable.** It is in the chain table for `wallet balance`; a 402 quoting it is refused, as is a policy that would allow signing there.
  - **CI now signs for real on merge.** A job installs the optional peers, creates an OWS wallet, drives `call` through a mock 402, and checks the signature recovers to the wallet address — the unit suite stubs `fetch` and fakes the signer, so nothing in it would catch a signature a facilitator rejects.

- 7c9eea1: Add `rh-x402 wallet balance`, reading native and token balances from the chain.

  - **`wallet balance` works on every backend**, because it reads the chain over JSON-RPC instead of asking the signer. `@open-wallet-standard/core` exports no balance function and the `local` keystore has nothing to ask, so this was a per-backend capability that usually answered "cannot" — which is why funding checks had to be done by hand with `curl` and an `eth_call`.
  - Reports the **native currency and every known token** on the chain: `--chain base`, `--chain ethereum`, `--chain base-sepolia`, repeatable. `--address` reads any address. Override an endpoint with `rpc.<chain>`; the built-in ones are public and rate-limited.
  - **Ethereum mainnet is now a known chain**, with USDC at `0xA0b8…eB48`. Its EIP-712 domain was read from the contract (`name()` "USD Coin", `version()` "2", `decimals()` 6) rather than copied from a doc, because a wrong domain produces a signature no facilitator will settle.
  - **`canPayX402` is a function of the token balance, never of ETH.** An x402 payment is an EIP-3009 authorization the facilitator submits, so the payer needs USDC and no gas at all. `wallet balance` exits `46` on a zero token balance and never on a zero gas balance. Conflating the two is how "insufficient funds for gas" gets read as "x402 needs ETH".
  - **A configured proxy that Node is ignoring is now named.** Node's `fetch` does not read `HTTPS_PROXY` unless started with `--use-env-proxy`, so on a proxied machine every request failed with a bare 403 or connection error that said nothing about the proxy. Network errors now say which proxy is set and how to enable it.

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
