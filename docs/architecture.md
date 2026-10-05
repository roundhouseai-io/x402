# Architecture

One engine, three surfaces. The CLI, the HTTP endpoint and the MCP server are thin adapters over `core/engine.ts`; every spend decision, every ledger write and every error code happens in one place.

```
   x402 call …            POST /v1/call            tools/call x402_call
        │                       │                          │
  commands/*.ts           serve/http.ts               serve/mcp.ts
        └───────────────────────┴──────────────────────────┘
                                │
                         core/engine.ts
      ┌──────────┬──────────┬───┴────┬───────────┬──────────┐
   data.ts    x402.ts    gates.ts signers/  authcache.ts  ledger.ts
  (payload)  (402 parse) (limits) (signing) (idempotency) (telemetry)
                                      │
                            ows │ local │ exec │ x402-signer-*
```

## The call flow

`Engine.call()` is the whole product. In order:

1. **Resolve the target.** `discover.ts` turns `x402:<capability>` into a URL: a config `pins` entry first (determinism), then the Roundhouse index filtered by allowlist, cheapest first. A plain URL passes straight through.
2. **Prepare the request.** `data.ts` has already merged dot flags, `--json` and stdin; `prepareRequest` applies the placement rules — query params with bracket notation for GET/HEAD/DELETE, a JSON body for POST/PUT/PATCH — and infers the method.
3. **Send it unpaid.** Any status other than 402 ends the call: the response is returned and a ledger record written with `amount: "0"`. Free endpoints cost one round trip and no wallet contact.
4. **Parse the 402.** `x402.ts` normalises the payload into `PaymentOption`s, tolerating the naming drift live providers show (`maxAmountRequired`/`price`/`amount`, `payTo`/`recipient`, `network`/`chainId`), then selects one: configured chain first, then cheapest. A payload it cannot use is exit `40`, not a guess.
5. **Gate.** `gates.ts` runs domain → payTo → `--max` → session budget → daily cap. First failure aborts with its own exit code, before any wallet contact. `--dry-run` stops here and reports the price.
6. **Authorize.** `eip3009.ts` builds the `TransferWithAuthorization` typed-data document; the resolved signer backend signs it — and receives nothing else. Before signing, `authcache.ts` is consulted — a live entry for this request identity is reused. Signing is serialised per engine, so two concurrent identical calls produce one authorization.
7. **Retry paid.** The same request with an `X-PAYMENT` header (base64 of the payment payload). A second 402 means the provider rejected the authorization: exit `40`, and the cache entry is not reused for a fresh attempt. A network failure here is exit `50` — money may have moved, so the authorization stays cached for an identical re-run.
8. **Record.** `ledger.ts` appends one JSONL record per call, at the configured payload level, with auth headers always redacted. `telemetry.ts` optionally queues it for the remote sink.

## Design decisions worth knowing

**Zero runtime dependencies.** This tool holds an API key that can spend money. Every dependency is another party who can reach that key through an update. Node 20+ gives us `fetch`, `node:crypto`, `node:http` and enough JSON to implement JSON-RPC by hand — so the CLI ships with nothing. `ethers` is an _optional_ peer dependency used only by the local development signer, so a default install carries no signing code at all.

**The engine never signs, and never chooses a wallet.** `SignerBackend` is a four-method interface (`capabilities`, `getAccounts`, `getAddress`, `signTypedData`, plus an optional `getBalance`). `ows` is the reference implementation, `local` a warned keystore for development, `exec` any executable; tests implement the interface directly. There is no code path that turns a private key into a signature inside `core/engine.ts`, which makes the "no fallback signing" invariant structural rather than aspirational.

**Backends see one EIP-712 payload and nothing else.** No URL, no request body, no response body — so a hostile or buggy backend cannot exfiltrate call content. The capability check runs when the signer is resolved, so a backend that cannot sign typed data fails at config time (exit 47) rather than halfway through a payment. Signing is serialised per backend _and_ wallet, so concurrent identical calls share one authorization.

**Amounts are `bigint` atomic units internally, decimal strings at the edges.** `assets.ts` owns the conversion, refuses more precision than the asset has, and never lets a price through `Number`. Ledger amounts are decimal strings; the sum helpers scale to integer micro-units before adding.

**Exit codes are the API.** `errors.ts` holds the table; `X402Error` carries one. Every surface renders the same number: exit status on the CLI, `errorCode` in the HTTP envelope, `errorCode` in the MCP tool result. `statusForCode()` maps to HTTP statuses for clients that only look at those.

**Output shape depends on the terminal, never on a flag being remembered.** A TTY gets a summary; anything else gets exactly one JSON object on stdout. `--raw` prints the body alone. Diagnostics always go to stderr, so a piped stdout is always parseable.

**State is private by construction.** `paths.ts` is the only module that writes under `~/.x402`, and it creates files 0600 and directories 0700. `X402_HOME` redirects the whole tree, which is how the test suite stays out of a developer's real ledger.

## Where things live

| Concern                                    | Module              |
| ------------------------------------------ | ------------------- |
| Exit-code table, error type                | `core/errors.ts`    |
| Flag table and argv parsing                | `core/args.ts`      |
| Dot-path data, coercion, query flattening  | `core/data.ts`      |
| 402 parsing and option selection           | `core/x402.ts`      |
| Chains, assets, unit conversion            | `core/assets.ts`    |
| Typed data, `X-PAYMENT`, settlement decode | `core/eip3009.ts`   |
| Spend gates                                | `core/gates.ts`     |
| Signer interface                           | `core/signer.ts`    |
| Backend registry and capability gate       | `core/signers/`     |
| OWS client and error mapping               | `core/ows.ts`       |
| Encrypted development keystore             | `core/keystore.ts`  |
| Idempotency                                | `core/authcache.ts` |
| Ledger and history queries                 | `core/ledger.ts`    |
| Payload levels, redaction, sink, outbox    | `core/telemetry.ts` |
| Capability resolution, index queries       | `core/discover.ts`  |
| The payment loop                           | `core/engine.ts`    |
| Caller tokens                              | `serve/tokens.ts`   |
