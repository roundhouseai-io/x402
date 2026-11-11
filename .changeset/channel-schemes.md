---
'@roundhouseai/x402': minor
---

Pay `batch-settlement` payment channels and `auth-capture` holds on EVM, and see and refund channels.

- `--scheme batch-settlement` opens a channel on the first call (a deposit into escrow plus a signed voucher; default five requests' worth, or the receiver's announced minimum, or `--deposit`) and pays later calls with a voucher that names a cumulative amount, with no on-chain transaction per request. `--scheme auth-capture` signs a hold for up to the quoted maximum, which the receiver captures later. Both are ported from the reference client in `@x402/evm` and checked against its output. **Neither is ever chosen without `--scheme`**: both move more money than the request in hand.
- Caps: a deposit counts in full against `--max`, the per-call cap, `--budget` and the daily cap; a voucher counts its request against `--max` and adds nothing to the budget or daily cap, because it draws on money already deposited; a hold counts its whole maximum. A voucher never names more than the channel's balance. Money that comes back is not credited to the daily cap.
- New command `rh-x402 channel list` (what is in escrow and what is refundable) and `rh-x402 channel refund <url> [--amount]` (a cooperative refund).
- Channel state is in `~/.x402/channels` (0600), written before a payment is sent. A deposit that was sent and not confirmed stays pending until it can no longer land; an unknown channel is read on-chain (one `eth_call`) before anything is signed, and a read that fails stops the call. A call holds a lock on its channel, so two calls cannot sign vouchers from the same state.
- `--allow-channels` on `setup`, `wallet create --policy` and `wallet policy` lets the OWS policy sign channel vouchers. **Opt-in**, and wider than it looks: OWS cannot narrow the rule to one channel or receiver.
- Keccak-256 is vendored (`core/keccak.ts`, about eighty lines, checked against the reference's hashes) because Node has none and the channel id and the hold nonce are Keccak hashes. No dependency is added. See `docs/spec-deviations.md` §17 for what this means for invariant 9, and for what is not implemented (the payer's on-chain withdrawal, capture or void of a hold, `erc20ApprovalGasSponsoring`).
- `serve` HTTP accepts `scheme` and `deposit` in the request body.
