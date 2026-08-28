---
'@roundhouseai/x402': patch
---

Add `rh-x402 wallet create`, a guided wallet setup, and correct the `ows-core` policy claim.

- **`rh-x402 wallet create`** asks how the key should be held (OWS, import a key file, or generate one), installs `@open-wallet-standard/core` if you pick OWS and it is missing, creates the wallet, writes the config, and prints the address to fund. It installs nothing without a prompt or `--install`, adopts an existing OWS wallet rather than creating over it, and never takes a passphrase as a flag. Without a terminal it needs `--path` and errors rather than hanging on an unanswerable question.
- **The install targets the `node_modules` that owns this package**, not the shell's cwd. `loadOwsCore` imports from this module's location, so a plain `npm i` in the wrong directory would appear to succeed and still fail to load — for a globally installed CLI it now uses `-g`, and for a project install a `--prefix`.
- **`ows-core` no longer claims a policy layer it does not have when signing with the vault passphrase.** OWS gates policies on _API-key_ callers — `createApiKey(name, walletIds, policyIds, …)` is what binds one — and a passphrase is owner access with nothing to bind a policy to. See the policy-gate entry below for what signing with an API key changes.
- **A wrong or missing vault passphrase is explained rather than reported as `decryption failed: aead::Error`.** This one hid well: the address resolves without the passphrase, so `signer check` passes and the first _payment_ is what fails. Setup now also records the `env:OWS_VAULT_PASS` indirection whenever the vault has a passphrase, and says to export it.
