---
'@roundhouseai/x402': patch
---

Stop `config set` accepting keys that do nothing, and point a stuck agent at `wallet create`.

All four of these come from watching an agent try to set up a wallet unaided and fail in ways that were the CLI's fault, not its own.

- **`config set` accepted any dotted key and reported success.** `rh-x402 config set signer.backend local` — the wrong key; the real one is `wallet.backend` — returned `ok: true`, wrote a branch nothing reads, and left every later command using the default backend while `config.json` looked configured. Unknown keys are now refused, with the nearest match named: `unknown config key "signer.backend". Did you mean wallet.backend, wallet.backends?`. Backend and pin subtrees stay open, since a third-party `x402-signer-<name>` may need keys this package cannot know.
- **`config unset <key>` is new.** There was no way to remove a key without hand-editing `config.json`, so a mistaken `set` was unfixable through the CLI. It prunes objects it empties, and deliberately skips validation so keys written before this check can still be removed.
- **"no wallet selected" now names `rh-x402 wallet create`.** Without that pointer an agent reads the message as an invitation to assemble a wallet by hand out of `npm i ethers`, `signer keystore generate` and `config set`, which is exactly what the guided command exists to prevent.
- **The docs no longer imply an OWS daemon exists.** `@open-wallet-standard/core` ships no `serve` or `daemon` command, so an agent told to point at `http://127.0.0.1:8402` goes looking for a service to start and finds nothing. Both README and `docs/signers.md` now say plainly that the HTTP backend is for a separate OWS service you already run, and that `ows-core` is the in-process path.

Note for anyone scripting against this: a `config set` of a key that never did anything now fails instead of silently succeeding. That is the fix, but it is a behaviour change.
