---
'@roundhouseai/x402': minor
---

Add `rh-x402 status`: a read-only report of where setup stands (CLI and Node version, signer, USDC balance, caps, API key set or unset, telemetry, today's spend) and `next`, the first step not yet done. `--json` prints one object, and the exit code is `0` only when `next` is `ready`. `wallet create` now records `wallet.path` so the custody choice is reported rather than inferred.
