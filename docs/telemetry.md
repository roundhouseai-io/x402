# Telemetry

Two layers: a local ledger that is always on, and an optional remote sink.

## The local ledger

Append-only JSONL at `~/.x402/ledger.jsonl`, created 0600. One record per call, paid or not — a free call is recorded with `amount: "0"`, because "how often did this agent call this endpoint" is as useful as "what did it spend".

```json
{
  "id": "01J8ZK3M9Q...",
  "ts": "2026-08-26T13:43:02.114Z",
  "url": "https://provider.example/v1/lei",
  "method": "GET",
  "wallet": "my-agent",
  "capability": "lei",
  "provider": "https://provider.example/v1/lei",
  "request": {
    "dataHash": "sha256:9f2c...",
    "dataKeys": ["query"],
    "headersHash": "sha256:aa01...",
    "headerNames": ["accept", "authorization"],
    "bytes": 214
  },
  "payment": {
    "paid": true,
    "amount": "0.002",
    "asset": "usdc",
    "chain": "eip155:8453",
    "payTo": "0x1831...",
    "scheme": "exact",
    "authHash": "sha256:bc44...",
    "cacheHit": false
  },
  "response": {
    "status": 200,
    "bodyHash": "sha256:77de...",
    "bytes": 1832,
    "latencyMs": 412,
    "paymentLatencyMs": 196
  },
  "exitCode": 0,
  "agent": { "session": "…", "tag": "…", "token": "agent-1" }
}
```

`agent.session` and `agent.tag` come from `X402_SESSION` and `X402_AGENT`. `agent.token` is the `rh-x402 serve` caller token name, which is what makes per-agent spend attribution work.

A record is written for failures too, with the `exitCode` and `error` that ended the call — including gate refusals, where `payment.paid` is `false` and `amount` is `"0"`. A truncated final line (process killed mid-write) is skipped on read rather than breaking `history`.

## Payload capture levels

Set with `--telemetry-payload` or config `telemetry.payload`.

| Level  | Request/response bodies stored as                        |
| ------ | -------------------------------------------------------- |
| `none` | Not recorded at all (byte counts only)                   |
| `hash` | SHA-256 + top-level key names + byte count (**default**) |
| `full` | Complete plaintext bodies                                |

**`hash` is the default deliberately.** Agents pass names, company data and eventually personal data through this tool. A default-on plaintext log of every payload is a data-protection liability and a second copy of sensitive data to secure — one that outlives the call, sits in a home directory, and nobody remembers to rotate. `hash` still answers the operational questions (was this the same request? how big was it? which fields were present?) without keeping the data.

Turn `full` on per call, for debugging and for endpoints you own:

```bash
rh-x402 call https://my-own-endpoint.example/v1/thing --telemetry-payload full
```

`telemetry.redactKeys` masks specific dot paths even at `full`, and understands `*` for one level of wildcard:

```json
"telemetry": { "payload": "full", "redactKeys": ["company.registrationNumber", "people.*.dob"] }
```

## Headers are always redacted

`Authorization`, `Proxy-Authorization`, `X-Api-Key`, `Api-Key`, `Cookie`, `Set-Cookie`, `X-PAYMENT`, `X-PAYMENT-RESPONSE` and their x402 v2 spellings (`PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, `PAYMENT-REQUIRED`) are never recorded at any level. Only their presence is, via `headerNames`; `headersHash` covers the non-sensitive values only. This is not configurable downwards.

## The remote sink

**On by default, and opt-out.** Every install sends to `https://api.roundhouseai.io/v0/telemetry` unless told not to. Any one of these turns it off:

```bash
rh-x402 config set telemetry.sink.enabled false   # durable, in config.json
export DO_NOT_TRACK=1                             # this shell, cross-tool convention
export X402_TELEMETRY=off                         # this shell, this tool only
```

The environment wins over the config file. `rh-x402 status` reports `telemetry.enabled`. The first time a batch is sent, one line on stderr says what is sent, where, and how to turn it off; a marker file in `~/.x402/` keeps it to once. `setup` does not ask; `setup --telemetry off` writes the opt-out.

Records are batched (50 records or 10 seconds, whichever comes first) and POSTed as `{ "records": [...] }` with a static bearer token.

```json
"telemetry": {
  "payload": "hash",
  "sink": {
    "url": "https://api.roundhouseai.io/v0/telemetry",
    "token": "env:ROUNDHOUSE_INGEST_TOKEN",
    "enabled": true
  }
}
```

The intended target is the Roundhouse indexer, which turns fleet-wide payment telemetry into the pricing and liveness data behind `rh-x402 discover`.

The endpoint is `POST https://api.roundhouseai.io/v0/telemetry`. The key is optional but worth sending: an anonymous caller is limited to 6 batches a minute per IP, a keyed one to 120 per key, and a bad key is refused with 401 rather than stored anonymously. Create a key at https://roundhouseai.io/dashboard/team. Roundhouse stores only hashes, byte counts and key names, never a request or response body, even at `full`. Records are kept as self-reported telemetry in their own table and are never mixed into the indexed settlement data.

**Sink failures never fail a call.** A failed batch is written to `~/.x402/outbox/` and flushed on the next invocation. `rh-x402 serve` flushes on a timer, and `GET /v1/health` reports `outboxDepth` so a stuck sink is visible.

Note what leaves the machine: whatever the payload level says. At `hash` that is URLs, hashes, key names, amounts, `payTo` addresses, timings and exit codes. At `full` it is your request and response bodies. Do not enable `full` and a remote sink together without deciding that is what you want.

## History queries

```bash
rh-x402 history --since 24h --paid-only        # recent paid calls
rh-x402 history --sum                          # total spend, by asset
rh-x402 history --by payTo --sum               # spend by recipient
rh-x402 history --by agent --sum               # spend by serve caller token
rh-x402 history --by day --sum                 # daily spend
rh-x402 history --since 7d --limit 20 provider.example   # filter by URL substring
```

`--by` accepts `payTo`, `url`, `wallet`, `asset`, `agent`, `day`, `capability`. On a TTY the output is a table; piped, it is JSON. The same queries are available over HTTP at `GET /v1/history`, filtered to the calling token's own records unless the token has the `admin` scope.

## Retention

Nothing is rotated for you. The ledger grows; it is one line per call. If you need retention limits, truncate or archive it yourself — and remember that `limits.dailyCap` is computed from it, so truncating today's records raises today's remaining cap.
