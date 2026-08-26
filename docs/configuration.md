# Configuration

Three layers, later wins:

1. `~/.x402/config.json` — user config, written 0600
2. `.x402rc` in the working directory — per-project overrides
3. Flags — per-call overrides

`X402_HOME` relocates the whole state tree (`config.json`, `ledger.jsonl`, `authcache/`, `outbox/`, `tokens.json`). The test suite relies on it; so can your CI.

## Full shape

```json
{
  "wallet": {
    "default": "my-agent",
    "owsEndpoint": "http://127.0.0.1:8402",
    "apiKey": "env:OWS_API_KEY"
  },
  "limits": { "maxPerCall": "0.05", "dailyCap": "5.00" },
  "allowlist": { "payTo": [], "domains": [] },
  "telemetry": {
    "payload": "hash",
    "redactKeys": [],
    "sink": {
      "enabled": false,
      "url": "https://ioi.md/ingest/v1/x402",
      "token": "env:IOI_INGEST_TOKEN",
      "batchSize": 50,
      "batchIntervalMs": 10000
    }
  },
  "defaults": { "chain": "base", "timeout": 30 },
  "discover": { "indexUrl": "https://ioi.md/api/v1" },
  "facilitator": { "url": null, "token": null },
  "pins": { "lei": "https://provider.example/v1/lei" },
  "serve": { "host": "127.0.0.1", "port": 8403 }
}
```

| Key                         | Meaning                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `wallet.default`            | OWS wallet name or id used when `--wallet` is absent                                                                  |
| `wallet.owsEndpoint`        | Base URL of the OWS agent access layer                                                                                |
| `wallet.apiKey`             | Bearer token for OWS. Use `env:` — see below.                                                                         |
| `limits.maxPerCall`         | Default `--max`. Exceeded → exit 44.                                                                                  |
| `limits.dailyCap`           | Daily spend cap computed from the ledger. Exceeded → exit 45. Advisory; mirror it as an OWS policy, which is binding. |
| `allowlist.payTo`           | Permitted recipient addresses. **Empty means allow-all.**                                                             |
| `allowlist.domains`         | Permitted hostnames; `*.example.com` matches subdomains only. **Empty means allow-all.**                              |
| `telemetry.payload`         | `none` \| `hash` (default) \| `full`                                                                                  |
| `telemetry.redactKeys`      | Dot paths masked even at `full`; `*` matches one level                                                                |
| `telemetry.sink`            | Remote ingest. Off by default; failures never fail a call.                                                            |
| `defaults.chain`            | Preferred chain, and the first tiebreak on multi-option 402s                                                          |
| `defaults.timeout`          | Total per-request timeout in seconds                                                                                  |
| `discover.indexUrl`         | IOI index base URL                                                                                                    |
| `facilitator.url`           | Settlement confirmation source for `x402 verify`                                                                      |
| `pins`                      | Capability → fixed provider URL, when determinism beats price                                                         |
| `serve.host` / `serve.port` | Defaults for `x402 serve`                                                                                             |

## Secrets

Any string value may be an `env:NAME` indirection, resolved from the environment at read time. `x402 config set` stores such a value literally, so the secret never lands in the file:

```bash
x402 config set wallet.apiKey env:OWS_API_KEY
```

A missing variable resolves to _absent_, not to the literal string `env:NAME` — an unset token is a disabled feature, not a bogus credential. Nothing in the config file needs to be a secret, and nothing in it should be.

## Managing it

```bash
x402 config list                       # effective config, with sources
x402 config get limits.maxPerCall
x402 config set limits.maxPerCall 0.05
x402 config set allowlist.domains '["*.provider.example"]'   # JSON values are parsed
```

Per-project overrides go in `.x402rc` next to your code — a good place for a low `limits.maxPerCall` and a project-specific `allowlist`. Arrays replace rather than merge, so a project allowlist fully overrides the user one.
