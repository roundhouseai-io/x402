# The unified endpoint

Not every agent can shell out to a CLI. Browser-based agents, hosted workflows and MCP-native clients need the same capability over plain HTTP or as a tool call. `rh-x402 serve` runs the same engine as a long-lived local service: same wallet, same gates, same ledger, same exit-code taxonomy.

```bash
rh-x402 serve                     # HTTP on 127.0.0.1:8403
rh-x402 serve --port 9000         # elsewhere
rh-x402 serve --mcp               # MCP server over stdio instead
```

## Security posture

**This is a spend-authorized proxy. Anything that can reach it can spend from the wallet.** Treat it like a hot wallet API even on localhost.

- It binds to `127.0.0.1` by default.
- Every route requires `Authorization: Bearer <caller-token>`. There is no unauthenticated mode.
- `--host 0.0.0.0` refuses to start without `--i-understand-this-exposes-spending`, and prints a warning naming the wallet when it does. Put real network exposure behind your own gateway with TLS; the server terminates plain HTTP only.
- Tokens are stored hashed in `~/.x402/tokens.json` (0600). The plaintext is shown once, at creation.

## Caller tokens

```bash
rh-x402 serve token create agent-1 --budget-daily 1.00 --max-per-call 0.01
rh-x402 serve token create scout --capabilities lei,kyb --max-per-call 0.005
rh-x402 serve token create ops --admin
rh-x402 serve token list
rh-x402 serve token revoke agent-1
```

| Option               | Effect                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--budget-daily`     | Daily spend cap for this token, computed from the ledger records carrying its name                                       |
| `--max-per-call`     | Per-call cap. The stricter of this and the request's own `max` wins.                                                     |
| `--capabilities a,b` | Restrict the token to those capability URIs. A token with a list can only call `x402:<one-of-them>`, not arbitrary URLs. |
| `--admin`            | May read every ledger record via `GET /v1/history`, not just its own                                                     |

Token limits sit **on top of** the global caps and the OWS policy layer, never instead of them. They fail with the same taxonomy: `44` over per-call max, `45` budget exhausted.

## Routes

All routes require a bearer token. Errors carry `errorCode` (the CLI exit code) and `errorName`.

### `POST /v1/call`

The whole payment loop in one request.

```bash
curl -s -X POST http://127.0.0.1:8403/v1/call \
  -H "Authorization: Bearer $X402_TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: lei-roundhouse-1' \
  -d '{
        "url": "x402:lei",
        "method": "GET",
        "data": { "query": "Roundhouse AI Ltd." },
        "max": "0.01"
      }'
```

Body fields: `url` (required; a URL or `x402:<capability>`), `method`, `data`, `headers`, `timeout`, `max`, `chain`, `dryRun`, `noCache`, `form`, `bodyAlways`, `wallet`, `signer`.

`wallet` and `signer` select the wallet and the [signer backend](signers.md) for that one call. Both are still subject to the caller token's own limits — a token cannot widen its budget by choosing a different wallet.

The response is the CLI envelope: `ok`, `status`, `paid`, `amount`, `asset`, `receiptId`, `body`, plus `capability`/`provider` when a capability was resolved.

### `POST /v1/probe`

`{ "url": … }`. Returns the parsed 402 requirements. Never pays.

### `GET /v1/discover?capability=lei`

Providers for a capability, cheapest first, filtered by allowlist. Includes the configured pin if there is one.

### `GET /v1/history`

Ledger queries: `since`, `until`, `paidOnly`, `limit`, `sum`, `by`. Filtered to the calling token's own records unless the token has `--admin`.

### `GET /v1/health`

Signer backend reachability, the active backend and wallet, outbox depth, payload level and configured limits. For the `ows` backend that is a live probe; for others it reports the capability check. Returns 503 when the wallet layer is unusable, which makes it a readiness probe.

## Concurrency and idempotency

Signing is serialised per backend and wallet, and the authorization cache is shared with the CLI, so two callers requesting the identical call concurrently produce one authorization, not two.

Send an `Idempotency-Key` and a replay within the authorization's validity window returns the original receipt without touching the provider. Response bodies are replayable only when `telemetry.payload` is `full`; otherwise the replay returns `bodyReplay: false` and no body — see [`telemetry.md`](telemetry.md) for why that trade is the right way round.

## MCP mode

```bash
rh-x402 serve --mcp
```

Serves MCP over stdio (JSON-RPC 2.0), exposing four tools whose schemas mirror the HTTP bodies:

| Tool            | Equivalent         |
| --------------- | ------------------ |
| `x402_call`     | `POST /v1/call`    |
| `x402_probe`    | `POST /v1/probe`   |
| `x402_discover` | `GET /v1/discover` |
| `x402_history`  | `GET /v1/history`  |

Example client configuration:

```json
{
  "mcpServers": {
    "x402": { "command": "rh-x402", "args": ["serve", "--mcp"] }
  }
}
```

In `--mcp` mode stdout belongs to the protocol; all diagnostics go to stderr. MCP mode has no caller tokens — the client owns the process, so its spend authority is the signer backend's own policy plus the global caps. Do not expose an MCP process to callers you would not hand a token to.

Per the spec's open question 5, MCP is expected to stabilise in v1.1; the HTTP surface with token budgets is the v1 target.

## Running it as a service

There is no daemon mode: run it under whatever supervises your other processes (systemd, launchd, a container). It shuts down cleanly on `SIGINT`/`SIGTERM`, flushing telemetry first.

```ini
# /etc/systemd/system/x402.service
[Service]
ExecStart=/usr/bin/rh-x402 serve
Environment=OWS_API_KEY=…
Restart=on-failure
User=x402
```
