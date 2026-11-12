# Deviations from the spec

Every knowing departure from [`SPEC.md`](SPEC.md), with the reason. If you change behaviour away from the spec, add a row here in the same PR — or change the spec instead.

## 1. `npx x402` is `npx @roundhouseai/x402` — resolved in the spec

**Spec (as authored):** §2 promised `npx x402 <url>`.

**Implementation:** the unscoped `x402` name on npm is already taken by another project, so `npx x402` resolves to that package, not this one. The zero-install form is `npx @roundhouseai/x402 <url>`; the binary is still called `x402`, so a global install gives the short command the spec describes.

The scope is `@roundhouseai`, matching the `roundhouseai-io` GitHub org.

**Status:** closed. §2 has been amended to `npx @roundhouseai/x402` throughout, so the spec and the implementation agree and this is no longer a deviation. Per-command examples elsewhere in the docs still use the short `x402 <subcommand>` form, which is what a global install gives you. No document should promise a bare `npx x402`.

## 2. The authorization cache key omits `validBefore`

**Spec:** §5.1 keys the cache on `hash(url + method + body + payTo + amount + validBefore)`.

**Implementation:** the key is `hash(method + url + hash(body) + payTo + amount + asset + chain + wallet)`; `validBefore` is stored _in_ the entry and used for expiry.

**Why:** `validBefore` is computed at signing time, so a key containing it can never be hit by a later retry — the retry would compute a new expiry, miss the cache, and sign again. That defeats the stated purpose of the cache (the primary defence against double payment). Keying on request identity and expiring on the stored `validBefore` gives the behaviour §5.1 describes.

**Status:** proposed spec amendment.

## 3. The domain allowlist is checked before the payTo allowlist

**Spec:** §5.4 lists the gates as payTo allowlist → `--max` → session budget → OWS policy, and §7 defines `allowlist.domains` without placing it in that order.

**Implementation:** domain → payTo → `--max` → session budget → daily cap → OWS policy.

**Why:** the domain gate is about _who you are talking to_ and can be evaluated from the request alone, so it is the cheapest possible refusal. It also produces the clearer error: "domain not in allowlist" beats a payTo mismatch for a provider you never intended to reach. Both still return exit `43`, so the contract is unchanged.

## 4. The daily cap is a distinct gate step

**Spec:** §7 defines `limits.dailyCap` as advisory and CLI-enforced from the ledger; §5.4's gate list does not name it.

**Implementation:** it is checked after the session budget and shares exit code `45` with it.

**Why:** §8 already assigns "session budget or daily cap exhausted" to `45`, so this only makes the ordering explicit.

## 5. `pay` does not use the authorization cache

**Spec:** §5.1 describes the cache in terms of the `call` flow.

**Implementation:** `rh-x402 pay` signs fresh every time.

**Why:** a bare 402 payload carries no request identity (no url, method or body), so there is nothing stable to key a cache entry on. Caching on the payload alone would risk returning an authorization for a _different_ request that happened to quote the same price. `pay` is a header-building primitive; callers that need idempotency should use `call`.

## 6. The `local` keystore refuses group-readable files too, and takes its passphrase from the environment only

**Spec:** §9.1 requires a refusal for a world-readable keystore; §5.3 says the passphrase comes "from env or prompt".

**Implementation:** the keystore refuses a group- _or_ world-readable file, and the passphrase comes from `X402_KEYSTORE_PASS` or a config `env:` indirection. There is no interactive prompt.

**Why:** a group-readable key on a shared machine is nearly as bad as a world-readable one, so the stricter check is free. The prompt is deliberately absent for now: the primary user is an agent with no terminal, a hidden-input prompt is easy to get wrong, and a half-working prompt is worse than a clear error telling you which variable to set. Worth adding when a human actually asks for it.

## 7. stdin is only consumed when it is genuinely readable

**Spec:** §4 lists stdin as a data mechanism.

**Implementation:** stdin is read when it is a pipe, socket or redirected file, or when a `-` argument explicitly asks for it. A terminal or character device (`/dev/null`, a detached tty in a hosted agent runtime) is never read. On a pipe, the wait for the _first_ byte is bounded — 500 ms by default, `X402_STDIN_WAIT_MS` to change it, no bound at all after an explicit `-`. Once any data arrives the read runs to EOF with no deadline.

**Why:** reading a character-device stdin can block forever, which to an agent is indistinguishable from a hung payment. The bound closes the same failure one layer up: `spawn(cli, args, { stdio: 'pipe' })` — the ordinary way an agent runs a subprocess — opens stdin and never writes to it, and nothing at the descriptor level tells that pipe apart from a slow one. Bounding only the first byte means a producer that has started is never truncated. `cat payload.json | rh-x402 call <url> --json -` and `rh-x402 call <url> < payload.json` both work.

## 8. `signer` is an extra command, and the keystore has one too

**Spec:** §3's command table does not list a signer command; §5.3 defines the backends but no way to inspect or populate them.

**Implementation:** `rh-x402 signer list`, `rh-x402 signer check [backend]`, `rh-x402 signer keystore list` and `rh-x402 signer keystore add <name> --key-file <path>`.

**Why:** §5.3 rule 2 requires the CLI to fail at _config_ time when a backend cannot sign typed data, which needs a command that resolves a backend and reports its capabilities — `signer check` is that command. And a `local` backend with no way to create a keystore entry is unusable. Keys are read from a file, never from argv, and the passphrase comes from the environment.

## 9. MCP transport is stdio only

**Spec:** §10 mentions "stdio or SSE".

**Implementation:** `--mcp` serves stdio.

**Why:** SSE is deprecated in the MCP transport spec in favour of streamable HTTP, and §12.5 already proposes deferring MCP to v1.1. Adding a second transport before the first is exercised is scope with no caller.

## 10. The envelope carries `paymentState`, and `paid` means submitted-or-settled

**Spec:** §8 defines the envelope with `paid: boolean` and no finer detail.

**Implementation:** the envelope also carries `paymentState`: `none`, `signed`, `submitted` or `settled`. `paid` is `submitted || settled`.

**Why:** `paid: true` was set the moment an authorization was signed, so a call the provider then rejected reported `paid: true` with a ledger amount of `0` — an agent reading it could not tell "money moved and the response was lost" from "nothing moved at all". The four states say which, and the exit code stays the thing to branch on.

`paid` is deliberately not reserved for `settled`. Most providers return no settlement receipt at all, and `limits.dailyCap` counts `paid` ledger records: a settled-only `paid` would leave real spend out of the ledger and quietly stop the cap binding. `settled` is the stronger claim where the provider makes it; `rh-x402 verify` confirms the rest.

## 11. x402 v2 is spoken alongside v1

**Spec:** §4-5 describe the v1 loop: sign an EIP-3009 authorization, retry with `X-PAYMENT`, read `X-PAYMENT-RESPONSE`.

**Implementation:** the protocol version is taken from the provider's own 402 and decides both the payload shape and the header. v1 is unchanged. v2 sends the [spec 5.2](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md) payload — the chosen requirements echoed under `accepted`, alongside `resource` and `extensions` — base64 in `PAYMENT-SIGNATURE`, and reads settlement from `PAYMENT-RESPONSE`. A version this build does not know fails with exit `40` before anything is signed.

**Why:** every provider on the current Roundhouse index quotes v2, and they reject a v1 envelope outright ("X-PAYMENT/v1 is unsupported"). The parser already read v2 requirements out of the `PAYMENT-REQUIRED` header; only the payment construction was still v1, so `probe` reported `x402Version: 2` while `call` signed v1 and paid nobody.

## 12. The remote telemetry sink is on by default

**Spec:** §6.3 says the remote sink is off by default.

**Implementation:** `telemetry.sink` defaults to `enabled: true` with `url: https://api.roundhouseai.io/v0/telemetry`. It is turned off by `config set telemetry.sink.enabled false`, `DO_NOT_TRACK=1` or `X402_TELEMETRY=off`; the environment wins over config. The payload level still defaults to `hash`, so no request or response body is sent unless `full` is chosen per call. The first batch prints one stderr notice saying what is sent, where, and how to opt out. `setup` no longer asks.

**Why:** the fleet-wide pricing and liveness data behind `discover` comes from this sink, and an opt-in sink that agents are asked about during setup is one they mostly skip. What leaves the machine at `hash` is still real: full URLs including query strings, `payTo` addresses, amounts, timings and exit codes. Operators who send personal data in query strings should opt out.

## 13. Spend limits have defaults

**Spec:** §7 leaves `limits.maxPerCall` and `limits.dailyCap` unset unless the operator sets them, and treats an unset cap as no cap.

**Implementation:** `maxPerCall` defaults to `1.00` and `dailyCap` to `5.00` (USDC). `--max` overrides the per-call default for one call; `config set` overrides either one. `status` marks them in `limitsDefault`, and setup keeps asking until the operator has written their own.

**Why:** a 402 is controlled by the provider, so with no cap a malicious endpoint could quote a wallet's whole balance and the CLI would sign it. The disclosure of 25 flaws in the x402 SDKs (October 2026) included this exact case in older clients. A safe default costs an operator one `config set`; an unsafe one costs the wallet.

## 14. Solana, and the payment path makes one RPC call there

**Spec:** the design is EIP-3009 throughout, and §5.3 says the engine hands a backend one EIP-712 payload. `core/rpc.ts` states that nothing in the payment path calls an RPC.

**Implementation:** `solana` and `solana-devnet` are payable chains. The payment is a partly signed v0 transaction (compute unit limit, compute unit price, SPL `TransferChecked`) rather than an authorization. A backend that can sign it declares `capabilities().svm` and implements `signSvmMessage(message)`, which receives the serialized message and returns a 64-byte signature. The engine reads one recent blockhash from `rpc.solana` after the gates pass, because a transaction cannot be built without it. The transaction is decoded again and checked against the quote before it is released (`core/svm.ts`). `@solana/web3.js` is an optional peer dependency, loaded on demand.

**Why:** the transaction has to carry a blockhash, so unlike an authorization it cannot be signed offline. The verification step exists because a Solana "payment" that moves no tokens, or the wrong amount, mint or recipient, is the failure the 2026 disclosure of x402 SDK flaws described. Invariant 7 still holds: no network call precedes a gate failure. Invariant 9 still holds: a default install has no new dependency, and `@solana/web3.js` (which brings about fifty transitive packages) is something an operator opts into.

## 15. The `solana-env` backend reads a raw private key from an environment variable

**Spec and invariant:** CLAUDE.md invariant 1 says keys never appear in argv, env vars or logs.

**Implementation:** the `solana-env` backend reads one ed25519 key from `X402_SOLANA_PRIVATE_KEY` (or the variable named by `wallet.backends.solana-env.keyEnv`). It warns on stderr at every signature, never prints the key or quotes a malformed one, and is documented as development and CI only. The key is never read from argv and never written to config, the ledger or the authorization cache.

**Why:** the operator asked for it. It is the weakest custody the CLI offers: an env var is inherited by child processes, readable from `/proc/<pid>/environ`, and easy to paste into a log. A hardware wallet or KMS behind the `exec` backend is the better answer for real funds, and a Solana backend on the encrypted keystore is open work.

## 16. `upto` on EVM, and a payment that reads the chain

**Spec:** the design is EIP-3009 `exact` throughout (§5.3: the engine hands a backend one EIP-712 payload), and `core/rpc.ts` says nothing in the payment path calls an RPC.

**Implementation:** an `upto` quote is paid with a Permit2 `PermitWitnessTransferFrom` signature for the ceiling (`core/permit2.ts`), in the v2 envelope with `payload.permit2Authorization`. The backend signs a second typed-data document, an EIP-2612 `Permit` for Permit2, when the quote declares `eip2612GasSponsoring` and the wallet's Permit2 allowance is short. Two read-only `eth_call`s decide that (`allowance`, `nonces`) against `rpc.<chain>`. The OWS policy gains an opt-in `--allow-permit2`, because the typed-data contract rule cannot name a token or spender.

**Why:** a provider that settles for real usage (token-metered inference) cannot be paid with `exact`, which takes the whole quote. Invariant 7 holds: the RPC reads happen after the gates, and a failed nonce read exits `1` with nothing sent. Amounts are not weakened: `--max` and the daily cap read the ceiling, the most the signature can move.

**Cost of the deviation:** a payment can now fail on an unreachable RPC where `exact` could not. `--scheme exact` avoids it when the provider offers both.

**Follow-ups to the above:**

- **`setup` allows Permit2 by default.** `setup` and `setup --yes` now create the OWS policy with Permit2 in `allowed_typed_data_contracts`, because the setup this CLI recommends has to be able to pay `upto`. `--no-allow-permit2` leaves it out. `wallet policy` and `wallet create --policy` stay opt-in (`--allow-permit2`). The default policy is therefore wider than before: OWS cannot restrict a contract-level rule to one token, spender or amount, so the wallet can sign Permit2 documents for any token it has approved to Permit2. Chains and expiry are still bounded.
- **The ledger counts what was settled, not the ceiling.** Gates still compare the ceiling. `payment.amount` is the amount the provider's receipt reports (header, or the last `x402_settlement` frame of a stream) when it is present, successful and not above the signed amount; otherwise the signed amount. `payment.ceiling` keeps the signature's amount when it differs. The daily cap and `--budget` count `amount`.
- **Not implemented:** the reference client's `erc20ApprovalGasSponsoring` fallback, which needs a signed transaction and `SignerBackend` only signs typed data. A token without EIP-2612 permit support on a wallet with no Permit2 allowance cannot be paid with `upto` here.
- **Exit 51 (`settlement_failed`).** A provider that runs the request and then cannot settle answers 5xx with `error.code` `settlement_failed`. That is recorded as `signed`, not paid, because the authorization was not captured. It is a new code rather than 50, whose guidance (re-run the identical command) is wrong for it.

## 17. `batch-settlement` and `auth-capture`: money that stays in escrow, a vendored Keccak, and state that outlives a call

**Spec:** one call, one authorization, one provider, and a payment that is over when the call is. Invariant 9: zero runtime dependencies. Invariant 6: the authorization cache is the double-payment defence.

**Implementation:** two more x402 EVM schemes, both ported from the reference client in `@x402/evm` and checked against its output (`test/fixtures/channel-vectors.json`, captured with time and randomness pinned; `test/channel.test.ts`, `test/authcapture.test.ts`).

- **`batch-settlement`** is a payment channel. The first call deposits (default `channels.depositMultiplier` requests' worth, minimum 3, default 5; or the receiver's announced `minDeposit`; or `--deposit`) into an escrow contract and signs a voucher; later calls sign only a voucher naming a cumulative amount the receiver may claim. Nothing goes on-chain per request. `rh-x402 channel list` shows payTo, network, what is deposited, what has been spent and what remains; `rh-x402 channel refund <url> [--amount <n>]` asks the receiver to return the rest or part of it.
- **`auth-capture`** is a hold. The payer signs an authorization that moves up to the quoted maximum into an escrow; the receiver captures what the work cost later and the rest is voided or reclaimed after it lapses. The ERC-3009 route signs under the token's own domain, so it needs nothing new in an OWS policy. The Permit2 route needs `--allow-permit2`.
- **Selection.** The default is still `upto` where the quote offers it, else `exact`. `--scheme` forces one scheme. `defaults.scheme` is the same preference and, when it names `batch-settlement` or `auth-capture`, opts in. `batch-settlement` is also chosen, ahead of `upto`, when this wallet already has an open channel for that payTo, asset and chain whose remaining escrow covers the request, so the call is a voucher and no new money moves. A quote that offers only an opt-in scheme, and no such channel, still fails and says to pass `--scheme`. `auth-capture` is never chosen without being named. Solana quotes stay `exact` only: `@x402/svm` `BatchSvmScheme` needs `@solana/kit`, a different stack from this CLI's `@solana/web3.js` path, and it builds transactions this CLI verifies itself before release.

**What the caps compare** (the gates run before anything is signed, on what the call moves):

- A **deposit** compares the deposit for `--max`, the per-call cap, the session budget and the daily cap. A default deposit is held to the per-call cap when the request itself fits under it; an explicit `--deposit` is not, so the cap can refuse it. `--max-deposit` (or `channels.maxDeposit`) is a further hard ceiling: a deposit is never signed above it, including an explicit `--deposit`, and a request that needs more than the ceiling is refused (exit 44) before anything is signed. The amount is printed on stderr before the deposit is signed. On a terminal, the deposit waits for confirmation unless `--yes` is set; with no terminal it proceeds, because the primary user is an agent and the caps are the consent. The deposit is the most the channel can ever cost, so many small vouchers cannot get past a cap the deposit already passed.
- A **voucher** compares the request amount for `--max` and the per-call cap, and adds **nothing** to the session budget or the daily cap: it draws on money already counted when it was deposited. After a deposit the ledger records `amount` = the deposit; a voucher records `amount` = 0 and `payment.channel.charged` = what the receiver took.
- A voucher never names more than the channel's balance: when it would, the call deposits first.
- A **hold** compares and records the whole maximum. A receipt for an authorization says nothing about what will be captured, so the settled-amount shortcut `upto` uses is not applied.
- Money that comes back (a refund, a voided hold) is **not** credited to the daily cap. The cap bounds money moved out, not net loss.

**Keccak.** Node has SHA3-256, which is a different function, and no Keccak-256. The channel id is an EIP-712 digest and the `auth-capture` nonce is a Keccak hash of the payment info, so both have to be computed before anything is signed. `core/keccak.ts` is about eighty lines of Keccak-256 plus the static ABI words the structs need, checked against the reference implementation's hashes (`test/keccak.test.ts`). The alternative was a dependency on `viem`, which invariant 9 forbids without a maintainer's agreement. **This is the line a reviewer should read hardest**: it signs nothing and holds no secret, but a wrong hash here would sign a document that does not name the channel it was meant for.

**State.** `~/.x402/channels/<slot>.json`, 0600 in a 0700 directory, one per (wallet, backend, chain, receiver, token, receiver authorizer). It holds the balance, what the receiver has charged, the highest cumulative voucher ever signed, and a deposit that was sent but not confirmed. It is written **before** a payment is sent, so a crash cannot lose the highest voucher or forget that a deposit is in flight. A lock file per channel is held from planning to the end of the call, because two vouchers signed from the same state would name the same total.

**What is believed, and what is not.**

- A receipt changes the balance and the charged total only if it says the settlement succeeded. A charge above the request amount is refused.
- A deposit with no confirming receipt stays _pending_ until its authorization can no longer be submitted (`validBefore`). Within that window a different request is refused; the same request replays the cached signature, so the worst case stays one deposit. After it, the chain is read (`channels(bytes32)` on the escrow, one `eth_call`) and a deposit that landed is adopted; one that did not is forgotten.
- A corrective 402 ("your total is out of step") is believed only if the total it names is no lower than what is known and no higher than the highest voucher ever signed, because the receiver cannot have been given more. The call is re-signed once. The reference client checks the receiver's stored voucher signature by recovering the signer; that needs secp256k1, which this CLI does not carry, so this bound is the substitute.
- With no local state, the chain is read before anything is signed, and a read that fails stops the call.

**Official client.** When `@x402/evm` is installed (optional peer, and a devDependency so CI has it), EVM `batch-settlement` payloads are built by `BatchSettlementEvmScheme` registered for `eip155:*`. The scheme's signer is an adapter over `SignerBackend`: the engine still never sees a key. The scheme reads channel state from `~/.x402/channels`, which implements the SDK's `ClientChannelStorage`. `FileClientChannelStorage` is not used, because its writer does not set mode 0600. When the peer is absent, the vendored port in `channel.ts` signs instead. Both paths are checked against the same fixtures. The deposit the scheme signs is the one the planner and the caps already accepted; a different amount is refused and not sent.

**What is not implemented.** The payer's own on-chain withdrawal after `withdrawDelay` (a transaction, which the signer interface cannot sign), `capture`, `void` and `reclaim` for holds (server or on-chain actions), the `erc20ApprovalGasSponsoring` extension, a separate voucher-signing key, and Solana `batch-settlement`. A lost `~/.x402/channels` while the receiver holds unclaimed vouchers is repaired from the chain's `totalClaimed`, which can lag what the receiver holds off-chain; until the receiver claims, calls on that channel may be refused with a corrective 402 the CLI will not believe.

**Policy.** `--allow-channels` (opt-in, on `setup`, `wallet create --policy` and `wallet policy`) adds the escrow contract to `allowed_typed_data_contracts`, so the wallet can sign vouchers. OWS cannot narrow that rule to one channel or receiver, so a policy with it lets the wallet sign a voucher for any channel it could open. The most a voucher can cost is the deposit it draws on, and the deposit passed the caps; a voucher cannot move money that was not deposited.

**Invariants that still hold.** The engine never signs: every document goes through `SignerBackend.signTypedData`. The escrow, collector and Permit2 addresses are constants, never read from a quote, and the `auth-capture` escrow must be one of the two known deployments. No new exit code. Gates run before any network call, and the one new read (the channel on-chain) happens after them, as the `upto` allowance read does.
