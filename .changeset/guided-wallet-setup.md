---
'@roundhouseai/x402': minor
---

Add `rh-x402 wallet create`, a guided wallet setup, and correct the `ows-core` policy claim.

- **`rh-x402 wallet create`** asks how the key should be held (OWS, import a key file, or generate one), installs `@open-wallet-standard/core` if you pick OWS and it is missing, creates the wallet, writes the config, and prints the address to fund. It installs nothing without a prompt or `--install`, adopts an existing OWS wallet rather than creating over it, and never takes a passphrase as a flag. Without a terminal it needs `--path` and errors rather than hanging on an unanswerable question.
- **The install targets the `node_modules` that owns this package**, not the shell's cwd. `loadOwsCore` imports from this module's location, so a plain `npm i` in the wrong directory would appear to succeed and still fail to load — for a globally installed CLI it now uses `-g`, and for a project install a `--prefix`.
- **`ows-core` now declares `policies: false`.** OWS gates policies on _API-key_ callers — `createApiKey(name, walletIds, policyIds, …)` is what binds one — and `signTypedData` takes no key or policy argument, so in-process signing has nothing to bind a policy to. Declaring `true` told operators they had a spend control they may not have. A binding policy layer means an OWS API key and the `ows` backend; the docs now say so.
- **A wrong or missing vault passphrase is explained rather than reported as `decryption failed: aead::Error`.** This one hid well: the address resolves without the passphrase, so `signer check` passes and the first _payment_ is what fails. Setup now also records the `env:OWS_VAULT_PASS` indirection whenever the vault has a passphrase, and says to export it.
