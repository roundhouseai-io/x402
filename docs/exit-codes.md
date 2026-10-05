# Exit codes

The codes are a stability contract from v1. New codes may be appended; existing ones are never renumbered or repurposed. The table lives in `src/core/errors.ts` and is surfaced identically on every surface:

- **CLI** — the process exit status, plus `errorCode`/`errorName` in the JSON envelope on a non-TTY stdout.
- **HTTP** (`rh-x402 serve`) — `errorCode` in the response body; the HTTP status is a convenience mapping (see below).
- **MCP** — `errorCode` inside the tool result, with `isError: true`.

| Code | Name                   | Meaning                                                                                                                                       | Retry?                                                                                      |
| ---- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0    | `ok`                   | Success, paid or free                                                                                                                         | —                                                                                           |
| 1    | `error`                | Generic, network, or usage error. Nothing was paid.                                                                                           | Yes                                                                                         |
| 40   | `invalid_402`          | The endpoint returned a 402 this tool cannot use, quoted an x402 version this build does not speak, or rejected a valid-looking authorization | No — report the provider                                                                    |
| 42   | `policy_denied`        | The OWS policy engine refused to sign — a token contract, chain or expiry outside the wallet's policy                                         | No — a human must widen the wallet policy                                                   |
| 43   | `allowlist_denied`     | `allowlist.payTo` or `allowlist.domains` excluded this call                                                                                   | No — the provider is not approved                                                           |
| 44   | `over_max`             | The quoted price exceeds `--max` / `limits.maxPerCall`                                                                                        | Only after a human raises the cap                                                           |
| 45   | `budget_exhausted`     | `--budget` for this process, or `limits.dailyCap` from the ledger, is spent                                                                   | No — stop spending                                                                          |
| 46   | `insufficient_balance` | The wallet cannot cover the quoted price                                                                                                      | No — fund the wallet                                                                        |
| 47   | `ows_unavailable`      | Signer backend unreachable, auth failed, or **unable to do what was asked**                                                                   | Read the message first: unreachable is retryable once, incapable never is                   |
| 50   | `paid_no_response`     | The paid request was sent but no valid response came back. **Money may have moved.** A receipt is logged.                                     | Re-run the _identical_ command; it reuses the cached authorization. Never add `--no-cache`. |

## Payment states

The exit code says whether the call worked; `paymentState` says what happened to
the money. Both appear in the envelope, and on every surface.

| `paymentState` | `paid`  | Meaning                                                                              |
| -------------- | ------- | ------------------------------------------------------------------------------------ |
| `none`         | `false` | Nothing was signed. Includes every gate refusal (43-46), `--dry-run`, and exit 47.   |
| `signed`       | `false` | An authorization was signed and the provider rejected it (exit 40). Nothing settled. |
| `submitted`    | `true`  | The authorization reached the provider and was not rejected. Assume the wallet paid. |
| `settled`      | `true`  | A settlement receipt confirms the transfer.                                          |

`paid` is `submitted || settled`, not `settled` alone. Most providers return no
settlement receipt, so a settled-only `paid` would leave real spend out of the
ledger — and `limits.dailyCap` counts `paid` records, so the cap would quietly
stop binding. `settled` is the stronger claim, available when the provider says
so; `rh-x402 verify <receiptId>` is how you confirm the rest.

Codes 2-39, 41, 48, 49 and 51+ are unassigned. `41` is deliberately skipped to leave room next to `40` for a distinct "payment rejected by provider" code if we decide to split that case out.

## HTTP status mapping

`statusForCode()` in `src/serve/http.ts`:

| Exit code           | HTTP status |
| ------------------- | ----------- |
| 0                   | 200         |
| 40, 50              | 502         |
| 42, 43              | 403         |
| 44, 45              | 429         |
| 46                  | 402         |
| 47                  | 503         |
| 1 and anything else | 500         |

Prefer `errorCode` over the status: the status is lossy by design.

## Guidance for agents

Two of these need care:

**Exit 47 covers two different situations, and they need opposite responses.** The backend being unreachable or unauthenticated is transient — retry once, then treat the wallet layer as down. The backend being _incapable_ is permanent: `needs the optional peer dependency ethers`, or a backend that cannot sign typed data at all. Retrying that forever gets you nowhere. Branch on the message, or ask `rh-x402 signer check` up front, which reports the capabilities a backend declares before any of it matters.

**Exit 50 is the one that costs money.** It means the authorization was handed to the provider and the response was lost. The authorization is cached, so re-running the identical command is safe and is the correct response — it either gets the paid response the first attempt missed or fails cleanly. Adding `--no-cache` after a 50 is how you pay twice.

**Exits 42, 43, 45 and 46 are human decisions.** They are not transient. Retrying them wastes calls and, in the case of 42, generates policy-denial noise in the wallet audit log. Report and stop.

**Exit 47 covers the whole wallet layer.** It means the signer backend is unreachable, rejected the CLI's credential, or cannot sign EIP-712 typed data at all. The last case is caught when the signer is resolved — before any HTTP request — so a backend that cannot do x402 fails at config time rather than mid-payment. Retry once, then treat the wallet layer as down.
