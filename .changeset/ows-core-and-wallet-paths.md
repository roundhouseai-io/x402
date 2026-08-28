---
'@roundhouseai/x402': patch
---

Add the `ows-core` signer backend, drop the `x402` bin, and make the three ways to hold a key explicit.

- **`ows-core`** signs through the `@open-wallet-standard/core` bindings in process, with no OWS daemon to run. It resolves this repo's longest-standing open question: the package does export `signTypedData`, verified by signing a real `TransferWithAuthorization` payload. It declares `balances: false` — the package exports no balance function, so the pre-flight funding check is skipped rather than guessed at.
- **`@open-wallet-standard/core` is a new optional peer dependency**, alongside `ethers`. A default install still carries no signing code and no runtime dependencies.
- **`rh-x402 signer keystore generate <name>`** creates a key in process and writes it straight to the encrypted keystore. It is never printed and cannot be read back. Not recommended for a funded wallet, and it warns on stderr.
- **Breaking for global installs: the `x402` bin is gone**, leaving `rh-x402`. The unscoped `x402` name on npm belongs to another project, and shipping that bin name invited a collision. `npx @roundhouseai/x402` is unaffected.
