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
      "url": "https://www.roundhouse.studio/api/v0/ingest/x402",
      "token": "env:ROUNDHOUSE_INGEST_TOKEN",
      "batchSize": 50,
      "batchIntervalMs": 10000
    }
  },
  "defaults": { "chain": "base", "timeout": 30 },
  "discover": { "indexUrl": "https://www.roundhouse.studio/api/v0" },
  "facilitator": { "url": null, "token": null },
  "pins": { "lei": "https://provider.example/v1/lei" },
  "serve": { "host": "127.0.0.1", "port": 8403 }
}
```

| Key                                   | Meaning                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `wallet.backend`                      | Active signer backend: `ows`, `ows-core`, `local`, `exec`, or a third-party `x402-signer-<name>`. See [`signers.md`](signers.md).  |
| `wallet.default`                      | Wallet name or id within that backend, used when `--wallet` is absent                                                              |
| `wallet.backends.ows.endpoint`        | Base URL of the OWS agent access layer                                                                                             |
| `wallet.backends.ows.apiKey`          | Bearer token for OWS. Use `env:` — see below.                                                                                      |
| `wallet.backends.ows-core.vaultPath`  | OWS vault path for the in-process backend. Omit to use the OWS default location.                                                   |
| `wallet.backends.ows-core.passphrase` | Vault passphrase; use `env:`. Omit for an unlocked vault or an OWS setup that prompts.                                             |
| `wallet.backends.local.keystore`      | Encrypted keystore path (`~` expanded). Development and CI only.                                                                   |
| `wallet.backends.local.passphrase`    | Keystore passphrase; use `env:`, or set `X402_KEYSTORE_PASS`                                                                       |
| `wallet.backends.exec.command`        | Executable implementing the [`exec` protocol](exec-signer.md)                                                                      |
| `limits.maxPerCall`                   | Default `--max`. Exceeded → exit 44.                                                                                               |
| `limits.dailyCap`                     | Daily spend cap computed from the ledger. Exceeded → exit 45. Advisory; mirror it in the backend's policy layer, which is binding. |
| `allowlist.payTo`                     | Permitted recipient addresses. **Empty means allow-all.**                                                                          |
| `allowlist.domains`                   | Permitted hostnames; `*.example.com` matches subdomains only. **Empty means allow-all.**                                           |
| `telemetry.payload`                   | `none` \| `hash` (default) \| `full`                                                                                               |
| `telemetry.redactKeys`                | Dot paths masked even at `full`; `*` matches one level                                                                             |
| `telemetry.sink`                      | Remote ingest. Off by default; failures never fail a call.                                                                         |
| `defaults.chain`                      | Preferred chain, and the first tiebreak on multi-option 402s                                                                       |
| `defaults.timeout`                    | Total per-request timeout in seconds                                                                                               |
| `discover.indexUrl`                   | Roundhouse index base URL. Queried as `<indexUrl>/endpoints?q=<capability>`.                                                       |
| `facilitator.url`                     | Settlement confirmation source for `rh-x402 verify`                                                                                |
| `pins`                                | Capability → fixed provider URL, when determinism beats price                                                                      |
| `serve.host` / `serve.port`           | Defaults for `rh-x402 serve`                                                                                                       |

## Discovery

`rh-x402 discover <capability>` and `x402:<capability>` resolution both call the Roundhouse index, across two surfaces tried in order:

```bash
# 1. The capability document — offers plus market-wide pricing. Registered slugs only.
curl -sL 'https://www.roundhouse.studio/unified.json?capability=web-search'

# 2. Fallback keyword search, for anything unified.json answers `unknown_capability` for.
curl -sL 'https://www.roundhouse.studio/api/v0/endpoints?q=lei'
```

`unified.json` is asked first because it is the only surface that reports the market, not just the list. When it does not know the slug the keyword search answers instead, and `stats` comes back `null`.

Each entry in the returned `offers` (or `endpoints`) array is mapped onto a provider:

| Index field         | Provider field | Used for                                                             |
| ------------------- | -------------- | -------------------------------------------------------------------- |
| `resource`          | `url`          | The endpoint that gets called                                        |
| `service_name`      | `capability`   | Display and ledger record; may be `null`, then the query is used     |
| `price_usdc`        | `price`        | Cheapest-first ordering and the `--max` gate                         |
| `asset`             | `asset`        | Contract address, resolved to a symbol (`usdc`) via `core/assets.ts` |
| `network`           | `chain`        | CAIP-2 (`eip155:8453`), resolved to a name (`base`) the same way     |
| `pay_to`            | `payTo`        | The `allowlist.payTo` gate                                           |
| `is_live`           | `live`         | Down endpoints sort last and are never auto-routed to                |
| `l30_total_calls`   | `calls30d`     | Reported in JSON output                                              |
| `l30_unique_payers` | `payers30d`    | Reported in JSON output                                              |

An unrecognised network or asset is passed through verbatim rather than dropped. `scheme`, `description`, `tags`, `icon_url` and `onchain_volume_usdc` are returned by the index but not currently mapped.

Providers are sorted live-first, then cheapest. `rh-x402 discover` lists every provider the allowlist permits, marking down ones `[down]`; resolving `x402:<capability>` for an actual call skips them. A `pins` entry bypasses the index entirely.

### Market stats

`unified.json` also reports the capability as a whole, surfaced as `stats` on `rh-x402 discover`, `GET /v1/discover` and the `x402_discover` MCP tool. It is what lets an agent price one offer against the market instead of against nothing:

| Field                           | Meaning                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `min` / `max`                   | Cheapest and dearest listed price, in the capability's `unit`                |
| `p25` / `median` / `p75`        | The distribution. `median` is the going rate                                 |
| `spread`                        | `max / min`. Wide means the cheapest offer is not automatically the sane one |
| `spot`                          | Average price actually paid, weighted by `spotBasis` (usually calls)         |
| `offers` / `providers` / `live` | How many offers, distinct providers, and reachable endpoints                 |

`spot` above `median` means demand sits on the dearer offers — often one expensive endpoint taking a large share of calls. These are an indexed snapshot, not a quote: the price that binds is the one in the live 402.

## Secrets

Any string value may be an `env:NAME` indirection, resolved from the environment at read time. `rh-x402 config set` stores such a value literally, so the secret never lands in the file:

```bash
rh-x402 config set wallet.backends.ows.apiKey env:OWS_API_KEY
```

A missing variable resolves to _absent_, not to the literal string `env:NAME` — an unset token is a disabled feature, not a bogus credential. Nothing in the config file needs to be a secret, and nothing in it should be.

## Managing it

```bash
rh-x402 config list                       # effective config, with sources
rh-x402 config get limits.maxPerCall
rh-x402 config set limits.maxPerCall 0.05
rh-x402 config set allowlist.domains '["*.provider.example"]'   # JSON values are parsed
```

Per-project overrides go in `.x402rc` next to your code — a good place for a low `limits.maxPerCall`, a project-specific `allowlist`, and a `wallet.backend` of `local` for tests. Arrays replace rather than merge, so a project allowlist fully overrides the user one.

Backend choice resolves the same way as everything else: `--signer` beats `.x402rc` beats `~/.x402/config.json`. `--wallet` selects within the backend, and `--keystore` points the `local` backend at another file.
