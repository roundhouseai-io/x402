# Roadmap

Milestones are tracked on GitHub; this is the shape of the plan and the reasoning.

## v0.1 — engine and surfaces (this repo, now)

The full loop works end to end against a mock provider and a mock wallet: 402 parsing with a compatibility shim, gates, EIP-3009 typed-data construction, `X-PAYMENT` retry, the authorization cache, the ledger, `serve` HTTP with caller tokens, and MCP over stdio. Signing goes through a pluggable backend — `ows`, `local` (encrypted keystore) and `exec` (JSON over stdio) all implemented. Nothing has been run against a live provider or a real wallet.

## Blocking v1

The spec's seven open questions, in order of how much they can hurt:

1. **Does OWS expose EIP-712 typed-data signing?** EIP-3009 cannot be signed with `signMessage`. The signer abstraction means a "no" no longer sinks the tool — `local` and `exec` work today — but it does sink OWS as the flagship backend, and that is an upstream conversation rather than a workaround. See [`signers.md`](signers.md).
2. **402 payload variance.** The parser already tolerates the naming drift we know about. It needs `probe` run across every provider on the current Roundhouse index, with each failure turned into a test case, before we can claim compatibility.
3. **Receipt verification.** `verify` asks a configured facilitator and otherwise reports the recorded settlement as untrusted. The proposal stands: facilitator in v1, on-chain in v1.1.
4. **Multi-option 402s.** Implemented as configured chain first, then cheapest, with the provider's own ordering as the final tiebreak. Needs confirming against real multi-option providers — "cheapest" is the wrong default if a cheaper chain settles slower than the caller can wait.
5. **Serve scope for v1.** Three surfaces to stabilise at once is a lot. Current plan: v1 ships the CLI and `serve` HTTP with token budgets; MCP and capability pinning are v1.1 unless a fleet needs MCP sooner.
6. **Prior art on the signer abstraction.** Solana Foundation's `pay` already splits "CLI prepares the payment" from "local wallet backend authorises it". Review its interface before ours sets: staying compatible with an existing signer protocol beats inventing a fourth one, and contributing an OWS backend to `pay` remains a live alternative to building all of this.
7. **The `exec` protocol needs pinning down.** Drafted in [`exec-signer.md`](exec-signer.md) and implemented, but framing, version negotiation and whether a long-lived process mode is needed are all still open. Third parties cannot build against a draft that might move.

## v1.0 — Base, USDC, `exact`

- Verified against live providers; the compatibility shim backed by tests per provider.
- OWS typed-data signing confirmed and pinned to a published API shape.
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
