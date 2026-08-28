---
'@roundhouseai/x402': patch
---

Never delete an OWS wallet; hide it instead.

- **`rh-x402 wallet forget <name>`** removes a wallet from this CLI's view by writing the name to `wallet.hidden` and clearing `wallet.default` if it pointed there. **The backend is untouched** — an OWS wallet keeps its funds, still appears in `ows wallet list`, and comes back with `rh-x402 wallet restore <name>`. `wallet list` reports how many are hidden, so a hidden wallet is not silently invisible.
- **The destructive OWS bindings are unreachable, not merely unused.** `@open-wallet-standard/core` exposes `deleteWallet`, `exportWallet` and `renameWallet`; none is declared on `OwsCoreModule`, and `test/owssafety.test.ts` fails the build if any is referenced from `src/`. A wallet holds money, so a tool that can spend from it should not also be able to destroy it — and `exportWallet` would pull a secret out of the vault, which the no-raw-private-keys rule already forbids. Recorded as an invariant in `CLAUDE.md`.
- **New config key `wallet.hidden`.**
