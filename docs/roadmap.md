# Roadmap

Milestones are tracked on GitHub; this is the shape of the plan and the reasoning.

## v0.1 — engine and surfaces (this repo, now)

The full loop works end to end against a mock provider and a mock OWS: 402 parsing with a compatibility shim, gates, EIP-3009 typed-data construction, `X-PAYMENT` retry, the authorization cache, the ledger, `serve` HTTP with caller tokens, and MCP over stdio. Nothing has been run against a live provider or a real wallet.

## Blocking v1

The spec's five open questions, in order of how much they can hurt:

1. **Does OWS expose EIP-712 typed-data signing?** EIP-3009 cannot be signed with `signMessage`. If the answer is no, the tool cannot exist in its intended form and this is an upstream conversation, not a workaround. Everything below is downstream of it. See [`ows.md`](ows.md).
2. **402 payload variance.** The parser already tolerates the naming drift we know about. It needs `probe` run across every provider on the current IOI index, with each failure turned into a test case, before we can claim compatibility.
3. **Receipt verification.** `verify` asks a configured facilitator and otherwise reports the recorded settlement as untrusted. The proposal stands: facilitator in v1, on-chain in v1.1.
4. **Multi-option 402s.** Implemented as configured chain first, then cheapest, with the provider's own ordering as the final tiebreak. Needs confirming against real multi-option providers — "cheapest" is the wrong default if a cheaper chain settles slower than the caller can wait.
5. **Serve scope for v1.** Three surfaces to stabilise at once is a lot. Current plan: v1 ships the CLI and `serve` HTTP with token budgets; MCP and capability pinning are v1.1 unless a fleet needs MCP sooner.

## v1.0 — Base, USDC, `exact`

- Verified against live providers; the compatibility shim backed by tests per provider.
- OWS typed-data signing confirmed and pinned to a published API shape.
- Facilitator-based `verify`.
- CLI and `serve` HTTP declared stable: exit codes and the JSON envelope become a contract.

Explicitly not in v1: non-Base chains, non-USDC assets, streaming responses, browser use.

## v1.1 and beyond

- On-chain settlement verification (trustless `verify`).
- MCP promoted to a supported surface, with a streamable-HTTP transport alongside stdio.
- Capability pinning and index-driven failover (try the cheapest, fall back on error).
- More chains and assets — the tables in `core/assets.ts` are the only thing that needs to change.
- Ledger retention and rotation.
- A `--wallet`-per-call story for fleets that segregate spend by wallet rather than by token.

## Not planned

- **Holding private keys.** Not now, not behind a flag, not "just for CI".
- **A hosted `serve`.** It is a spend-authorized proxy; it belongs on the machine that owns the wallet, behind your own gateway.
- **Runtime dependencies** for anything Node 20 can already do.
