---
'@roundhouseai/x402': minor
---

Honour `HTTPS_PROXY`, ship `SKILL.md` through the CLI, and close two ways a call could hang or overspend.

- **A price gate the counterparty can no longer rescale.** `--max` is compared in atomic units scaled by the asset's decimals, and those decimals were taken from the 402 payload. A provider quoting real 6-decimal USDC while declaring 18 got a cap 10^12 too large: `--max 0.05` would wave through a demand for fifty billion USDC while reporting that the gate held. Decimals now come from the asset table, a payload that disagrees is refused (exit `40`), and the EIP-712 domain comes from the table too — `extra` is the seller describing a contract it does not own.
- **An unknown token contract is refused rather than priced on the seller's word** (exit `40`), naming what is known on that chain. Adding one is a table entry in `core/assets.ts` with the decimals and domain read from the contract.
- **A piped stdin no longer hangs the CLI.** `spawn(cli, args, { stdio: 'pipe' })` — the ordinary way an agent runs a subprocess — opens stdin and never writes to it, and the read blocked forever: `rh-x402 probe <url>` never returned. The wait for the first byte is now bounded (500 ms, `X402_STDIN_WAIT_MS`), unbounded after an explicit `-`, and never applied once data has started, so a slow producer is not truncated.
- **`HTTPS_PROXY` and `HTTP_PROXY` are honoured**, through a CONNECT tunnel built on Node's own `http`/`tls` — no dependency, and no `--use-env-proxy`, which needs Node 22. `NO_PROXY` is respected and loopback always bypasses, so a local OWS daemon is never asked for through a proxy.
- **`rh-x402 skill` prints the agent-facing `SKILL.md`**, and `--help` now carries worked examples and the exit-code table.
- **Ethereum mainnet is readable but not payable.** It is in the chain table for `wallet balance`; a 402 quoting it is refused, as is a policy that would allow signing there.
- **CI now signs for real on merge.** A job installs the optional peers, creates an OWS wallet, drives `call` through a mock 402, and checks the signature recovers to the wallet address — the unit suite stubs `fetch` and fakes the signer, so nothing in it would catch a signature a facilitator rejects.
