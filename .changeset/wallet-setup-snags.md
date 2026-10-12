---
'@roundhouseai/x402': patch
---

Fix the snags an agent hit setting up a wallet from `skill.md`.

- `setup` and the changes it builds on (`wallet balance --wait`, `config set auth.apiKey`, `discover --policy`, `help exit-codes`) were merged into intermediate branches and never reached a release. They ship now, so `rh-x402 setup --daily-cap 5 ...` works as documented.
- `wallet create --path import|generate` (and `setup` with those paths) checks for `X402_KEYSTORE_PASS` and the optional `ethers` peer before it asks for or writes anything, and reports both in one error. The message says how to install `ethers` next to the CLI, including `npx -p @roundhouseai/x402 -p ethers rh-x402 ...`.
- `status` warns when a local keystore wallet has no passphrase or no `ethers` in this shell, so a missing passphrase shows before the first paid call rather than on it.
- `config set` refuses a plain value on a group of settings. `config set telemetry on` used to replace the whole `telemetry` object, after which `status` threw `Cannot read properties of undefined (reading 'enabled')`. A config file already in that state now loads with an error that names the key and the fix, and `status` reports it instead of crashing.
- `telemetry.sink.enabled` accepts `on`/`off`/`yes`/`no` and stores a boolean. `off` used to be stored as a string and read as on by the telemetry sink.
