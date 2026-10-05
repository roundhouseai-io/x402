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
    "backend": "ows",
    "default": "my-agent",
    "backends": {
      "ows": { "endpoint": "http://127.0.0.1:8402", "apiKey": "env:OWS_API_KEY" },
      "local": { "keystore": "~/.x402/keystore.json", "passphrase": "env:X402_KEYSTORE_PASS" },
      "exec": { "command": "/usr/local/bin/my-signer" }
    }
  },
  "limits": { "maxPerCall": "0.05", "dailyCap": "5.00" },
  "allowlist": { "payTo": [], "domains": [] },
  "telemetry": {
    "payload": "hash",
    "redactKeys": [],
    "sink": {
      "enabled": false,
      "url": "https://api.roundhouseai.io/v0/telemetry",
      "token": "env:ROUNDHOUSE_API_KEY",
      "batchSize": 50,
      "batchIntervalMs": 10000
    }
  },
  "defaults": { "chain": "base", "timeout": 30 },
  "discover": { "indexUrl": "https://api.roundhouseai.io/v0" },
  "facilitator": { "url": null, "token": null },
  "pins": { "lei": "https://provider.example/v1/lei" },
  "serve": { "host": "127.0.0.1", "port": 8403 }
}
```

| Key                                | Meaning                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `wallet.backend`                   | Active signer backend: `ows`, `local`, `exec`, or a third-party `x402-signer-<name>`. See [`signers.md`](signers.md).              |
| `wallet.default`                   | Wallet name or id within that backend, used when `--wallet` is absent                                                              |
| `wallet.backends.ows.endpoint`     | Base URL of the OWS agent access layer                                                                                             |
| `wallet.backends.ows.apiKey`       | Bearer token for OWS. Use `env:` — see below.                                                                                      |
| `wallet.backends.local.keystore`   | Encrypted keystore path (`~` expanded). Development and CI only.                                                                   |
| `wallet.backends.local.passphrase` | Keystore passphrase; use `env:`, or set `X402_KEYSTORE_PASS`                                                                       |
| `wallet.backends.exec.command`     | Executable implementing the [`exec` protocol](exec-signer.md)                                                                      |
| `limits.maxPerCall`                | Default `--max`. Exceeded → exit 44.                                                                                               |
| `limits.dailyCap`                  | Daily spend cap computed from the ledger. Exceeded → exit 45. Advisory; mirror it in the backend's policy layer, which is binding. |
| `allowlist.payTo`                  | Permitted recipient addresses. **Empty means allow-all.**                                                                          |
| `allowlist.domains`                | Permitted hostnames; `*.example.com` matches subdomains only. **Empty means allow-all.**                                           |
| `telemetry.payload`                | `none` \| `hash` (default) \| `full`                                                                                               |
| `telemetry.redactKeys`             | Dot paths masked even at `full`; `*` matches one level                                                                             |
| `telemetry.sink`                   | Remote ingest. Off by default; failures never fail a call.                                                                         |
| `defaults.chain`                   | Preferred chain, and the first tiebreak on multi-option 402s                                                                       |
| `defaults.timeout`                 | Total per-request timeout in seconds                                                                                               |
| `discover.indexUrl`                | Roundhouse index base URL                                                                                                          |
| `facilitator.url`                  | Settlement confirmation source for `x402 verify`                                                                                   |
| `pins`                             | Capability → fixed provider URL, when determinism beats price                                                                      |
| `serve.host` / `serve.port`        | Defaults for `x402 serve`                                                                                                          |

## Secrets

Any string value may be an `env:NAME` indirection, resolved from the environment at read time. `x402 config set` stores such a value literally, so the secret never lands in the file:

```bash
x402 config set wallet.backends.ows.apiKey env:OWS_API_KEY
```

A missing variable resolves to _absent_, not to the literal string `env:NAME` — an unset token is a disabled feature, not a bogus credential. Nothing in the config file needs to be a secret, and nothing in it should be.

## Managing it

```bash
x402 config list                       # effective config, with sources
x402 config get limits.maxPerCall
x402 config set limits.maxPerCall 0.05
x402 config set allowlist.domains '["*.provider.example"]'   # JSON values are parsed
```

Per-project overrides go in `.x402rc` next to your code — a good place for a low `limits.maxPerCall`, a project-specific `allowlist`, and a `wallet.backend` of `local` for tests. Arrays replace rather than merge, so a project allowlist fully overrides the user one.

Backend choice resolves the same way as everything else: `--signer` beats `.x402rc` beats `~/.x402/config.json`. `--wallet` selects within the backend, and `--keystore` points the `local` backend at another file.
