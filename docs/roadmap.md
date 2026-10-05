# Roadmap

Milestones are tracked on GitHub; this is the shape of the plan and the reasoning.

## v0.1 — engine and surfaces (this repo, now)

The full loop works end to end against a mock provider and a mock wallet: 402 parsing with a compatibility shim, gates, EIP-3009 typed-data construction, `X-PAYMENT` retry, the authorization cache, the ledger, `serve` HTTP with caller tokens, and MCP over stdio. Signing goes through a pluggable backend — `ows` (HTTP daemon), `ows-core` (the OWS bindings, in process), `local` (encrypted keystore) and `exec` (JSON over stdio) all implemented. Nothing has been run against a live provider or a real wallet.

## Blocking v1

The spec's remaining open questions, in order of how much they can hurt. The first — _does OWS expose EIP-712 typed-data signing?_ — is **answered**; the detail is under [Answered](#answered) below.

1. **402 payload variance.** The parser already tolerates the naming drift we know about. It needs `probe` run across every provider on the current Roundhouse index, with each failure turned into a test case, before we can claim compatibility.
2. **Receipt verification.** `verify` asks a configured facilitator and otherwise reports the recorded settlement as untrusted. The proposal stands: facilitator in v1, on-chain in v1.1.
3. **Multi-option 402s.** Implemented as configured chain first, then cheapest, with the provider's own ordering as the final tiebreak. Needs confirming against real multi-option providers — "cheapest" is the wrong default if a cheaper chain settles slower than the caller can wait.
4. **Serve scope for v1.** Three surfaces to stabilise at once is a lot. Current plan: v1 ships the CLI and `serve` HTTP with token budgets; MCP and capability pinning are v1.1 unless a fleet needs MCP sooner.
5. **Prior art on the signer abstraction.** Solana Foundation's `pay` already splits "CLI prepares the payment" from "local wallet backend authorises it". Review its interface before ours sets: staying compatible with an existing signer protocol beats inventing a fourth one, and contributing an OWS backend to `pay` remains a live alternative to building all of this.
6. **The `exec` protocol needs pinning down.** Drafted in [`exec-signer.md`](exec-signer.md) and implemented, but framing, version negotiation and whether a long-lived process mode is needed are all still open. Third parties cannot build against a draft that might move.

## Answered

**Does OWS expose EIP-712 typed-data signing?** Yes. `@open-wallet-standard/core@1.4.2` exports `signTypedData`, verified by signing a real `TransferWithAuthorization` payload with it — 65 bytes, `v` appended, recovery id 27/28. This was the repo's longest-standing blocker, on the reasoning that the published core types showed only `signMessage` with `utf8`/`hex`, neither of which can produce an EIP-712 signature. The types were not the whole surface.

The `ows-core` backend is built on it, so OWS is a working wallet for x402 today. What remains open is narrower than the original question: the HTTP daemon's `POST /v1/wallets/:wallet/sign-typed-data` route has not been exercised against a running OWS, so the `ows` backend still assumes the capability rather than confirming it. That belongs with item 1 above — verification against something live — not with a design question. See [`signers.md`](signers.md).

## v1.0 — Base, USDC, `exact`

- Verified against live providers; the compatibility shim backed by tests per provider.
- OWS typed-data signing pinned to a published API shape, and the HTTP daemon's route confirmed against a running OWS.
- The signer interface and the `exec` protocol frozen, with at least one out-of-tree backend built against them.
- Facilitator-based `verify`.
- CLI and `serve` HTTP declared stable: exit codes and the JSON envelope become a contract.

Explicitly not in v1: non-Base chains, non-USDC assets, streaming responses, browser use.

## v1.1 and beyond

- On-chain settlement verification (trustless `verify`).
- MCP promoted to a supported surface, with a streamable-HTTP transport alongside stdio.
- Capability pinning and index-driven failover (try the cheapest, fall back on error).
- More chains and assets — the tables in `core/assets.ts` are the only thing that needs to change.
- An `awal` backend, adapting Coinbase's Agentic Wallet CLI for teams already on it.
- Ledger retention and rotation.
- A `--wallet`-per-call story for fleets that segregate spend by wallet rather than by token.

## Not planned

- **Holding private keys in the engine.** Not now, not behind a flag. The `local` backend's encrypted keystore is the development path, and it warns every time it signs.
- **A hosted `serve`.** It is a spend-authorized proxy; it belongs on the machine that owns the wallet, behind your own gateway.
- **Runtime dependencies** for anything Node 20 can already do.
