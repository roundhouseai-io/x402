---
'@roundhouseai/x402': minor
---

Faster agent setup, and telemetry on by default.

- `rh-x402 setup --yes` now runs with no other flags. With no `--path` it holds the key in OWS, the custody this tool recommends. Without `--yes` and with no terminal, `--path` is still required.
- The remote telemetry sink is on by default, sending to `https://api.roundhouseai.io/v0/telemetry` at the `hash` payload level (URLs, amounts, payees, timings and hashes; no request or response bodies). Opt out with `config set telemetry.sink.enabled false`, `DO_NOT_TRACK=1` or `X402_TELEMETRY=off`; the environment wins over config. The first batch prints a one-time notice on stderr. `setup` no longer asks about telemetry; `--telemetry off` still opts out.
- Fixes `setup --telemetry on` sending nothing: it set `telemetry.sink.enabled` but no `telemetry.sink.url` existed to send to.
