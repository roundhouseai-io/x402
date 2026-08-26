# The `exec` signer protocol

**Version:** 1 (draft — spec open question 7)

A signer backend that is any executable. The CLI runs it, writes one JSON request to its stdin, and reads one JSON response from its stdout. In the style of git credential helpers: no daemon, no socket, no SDK, no language requirement.

This page is the contract third parties build against. It is a draft: the framing and error codes below are implemented, and breaking changes before v1 are possible while the shape settles.

## Framing

- **One process per request.** The CLI spawns `command` with `args`, writes a single JSON object followed by `\n` to stdin, then closes stdin.
- **One JSON object on stdout**, on a single line. If several lines are written, the last line that starts with `{` wins — so a helper may print progress lines first, though stderr is the better place.
- **stderr is inherited**, so anything the helper writes there reaches the operator's terminal. Use it for prompts, hardware-wallet instructions and diagnostics.
- **Exit code is advisory.** A helper that writes a valid response and exits non-zero is honoured; a helper that exits without a response fails with exit `47`.
- **Timeout** defaults to 30 s, configurable via `wallet.backends.exec.timeoutMs`. On timeout the process is killed with `SIGKILL` and the call fails with exit `47`. Set it generously if a human has to touch a device.

## Request

```json
{
  "x402Signer": 1,
  "id": "m1k2j3",
  "method": "signTypedData",
  "params": {
    "wallet": "my-agent",
    "typedData": {
      "types": { "EIP712Domain": [ … ], "TransferWithAuthorization": [ … ] },
      "primaryType": "TransferWithAuthorization",
      "domain": { "name": "USD Coin", "version": "2", "chainId": 8453, "verifyingContract": "0x8335…" },
      "message": {
        "from": "0x…", "to": "0x1831…", "value": "2000",
        "validAfter": "1787758251", "validBefore": "1787758431", "nonce": "0x…"
      }
    }
  }
}
```

`x402Signer` is the protocol version. `id` is opaque; echo it back if you like. `params.wallet` is always present.

**`params` carries nothing but `wallet` and the method's own arguments.** There is no URL, no request body, no response body, no header — by design (spec §5.3 rule 1). A helper cannot exfiltrate call content because it never receives any. If a future method needs more, it gets its own method and its own review.

## Methods

| Method          | Params                | Result                                                       |
| --------------- | --------------------- | ------------------------------------------------------------ |
| `capabilities`  | `wallet`              | `{ typedData, policies, balances, accounts }` — all booleans |
| `getAccounts`   | `wallet`              | `{ accounts: [{ id, address, chains? }] }`                   |
| `getAddress`    | `wallet`, `chain?`    | `{ address }` — 0x-prefixed, 20 bytes                        |
| `signTypedData` | `wallet`, `typedData` | `{ signature }` — 0x-prefixed hex, 65 bytes for secp256k1    |

`capabilities` is called first, when the signer is resolved, and its answer is cached for the process. Returning `typedData: false` fails the call at config time with exit `47` — which is the polite way for a helper to say "I cannot do x402".

## Response

Success:

```json
{ "x402Signer": 1, "id": "m1k2j3", "result": { "signature": "0xabc…" } }
```

Failure:

```json
{
  "x402Signer": 1,
  "id": "m1k2j3",
  "error": { "code": "policy_denied", "message": "over daily limit" }
}
```

`message` is shown to the operator, so make it specific. `code` maps onto the CLI's exit-code taxonomy:

| `error.code`                                | CLI exit code                      |
| ------------------------------------------- | ---------------------------------- |
| `policy_denied`, `denied`                   | 42 — denied by backend policy      |
| `insufficient_balance`                      | 46 — wallet cannot cover the price |
| `unsupported`, `unavailable`, `auth_failed` | 47 — backend cannot serve this     |
| anything else, or absent                    | 1 — generic error                  |

Choose the code deliberately: agents are told never to retry 42, 43, 45 and 46, and to retry 47 once. A refusal miscoded as a generic error will be retried.

## A minimal helper

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';

const input = JSON.parse(readFileSync(0, 'utf8'));
const reply = (body) =>
  process.stdout.write(JSON.stringify({ x402Signer: 1, id: input.id, ...body }) + '\n');

const wallet = new Wallet(process.env.MY_SIGNER_KEY);

switch (input.method) {
  case 'capabilities':
    return reply({ result: { typedData: true, policies: false, balances: false, accounts: true } });
  case 'getAccounts':
    return reply({ result: { accounts: [{ id: 'default', address: wallet.address }] } });
  case 'getAddress':
    return reply({ result: { address: wallet.address } });
  case 'signTypedData': {
    const { EIP712Domain, ...types } = input.params.typedData.types;
    const signature = await wallet.signTypedData(
      input.params.typedData.domain,
      types,
      input.params.typedData.message,
    );
    return reply({ result: { signature } });
  }
  default:
    return reply({ error: { code: 'unsupported', message: input.method } });
}
```

```bash
x402 config set wallet.backend exec
x402 config set wallet.backends.exec.command /usr/local/bin/my-signer
x402 signer check exec
```

## Notes for helper authors

- **Look at what you are signing.** `domain.verifyingContract` is the token, `message.to` is the recipient, `message.value` is the amount in atomic units, `message.validBefore` is when the authorization expires. That is enough to enforce a real policy — do, if you can.
- **A refusal is a feature.** Returning `policy_denied` is how a helper becomes a spend control rather than a rubber stamp.
- **Be idempotent-friendly.** The CLI caches authorizations, so the same call should not reach you twice — but if it does, signing again is safe only if your policy counts it once.
- **Do not log the signature** anywhere the caller cannot see. It is bearer authority over the amount in the payload until `validBefore`.
- **Version negotiation** is not settled: today the CLI sends `x402Signer: 1` and does not check what comes back. Reject an unknown version explicitly with `unsupported` if you care.

## Still open

Tracked as spec open question 7:

- whether a long-lived process mode (one spawn, many requests) is worth the complexity for hardware wallets that are slow to initialise;
- whether the protocol should carry a nonce or a request signature so a helper can prove which CLI asked;
- formal version negotiation;
- whether `getBalance` belongs in the protocol at all, or stays out so helpers need no chain access.
