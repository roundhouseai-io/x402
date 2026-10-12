---
'@roundhouseai/x402': minor
---

Add `rh-x402 setup`: one command from nothing to a funded wallet, a proven payment path and a stored API key. Every answer has a flag, so it runs with no terminal (`--path`, `--max-per-call`, `--daily-cap`, `--telemetry`, `--org-key`, `--min-balance`, `--fund-timeout`, `--yes`). It is idempotent and resumable, skipping a step when `status` says it is done, and exits non-zero on the first failing step with that step's name and exit code. `--json` prints one object per step, `--dry-run` makes no wallet, config write or payment, and the API key is never printed unless `--print-key`. `status` now reports `signer.policyKey` and `spend.calls.total`.
