---
'@roundhouseai/x402': patch
---

Point people at the backend that needs no daemon, and show which config values nobody chose.

From a second round of agent testing against a real OWS wallet, where the whole session was spent hunting a daemon that does not exist.

- **"OWS unreachable at 127.0.0.1:8402" now names the fix.** On a loopback endpoint it adds: nothing is listening, `@open-wallet-standard/core` ships no daemon, so switch to `ows-core`, which talks to the same vault in process. Previously the message read as a service that had failed to start, and the reasonable response was to go looking for it — `ows --help | grep daemon`, `ps aux | grep ows`, both empty. Remote endpoints are left alone, since a service there may genuinely be down.
- **`config list` distinguishes a default from a choice.** JSON output carries an `origins` map (`default` | `user` | `project` | `flag`) per key; terminal output lists which keys are showing defaults. `wallet.backend: "ows"` printed identically whether or not anyone set it, which is how an untouched default came to look like it was overriding something.
- **`signer keystore add` and `generate` prompt for a passphrase on a terminal**, the way `wallet create` already does, instead of requiring `X402_KEYSTORE_PASS` and only saying so after failing.
- **`--help` names the exec protocol doc** (`docs/exec-signer.md`), which existed and was hard to find from the CLI.
