---
'@roundhouseai/x402': minor
---

Add `rh-x402 wallet balance`, reading native and token balances from the chain.

- **`wallet balance` works on every backend**, because it reads the chain over JSON-RPC instead of asking the signer. `@open-wallet-standard/core` exports no balance function and the `local` keystore has nothing to ask, so this was a per-backend capability that usually answered "cannot" — which is why funding checks had to be done by hand with `curl` and an `eth_call`.
- Reports the **native currency and every known token** on the chain: `--chain base`, `--chain ethereum`, `--chain base-sepolia`, repeatable. `--address` reads any address. Override an endpoint with `rpc.<chain>`; the built-in ones are public and rate-limited.
- **Ethereum mainnet is now a known chain**, with USDC at `0xA0b8…eB48`. Its EIP-712 domain was read from the contract (`name()` "USD Coin", `version()` "2", `decimals()` 6) rather than copied from a doc, because a wrong domain produces a signature no facilitator will settle.
- **`canPayX402` is a function of the token balance, never of ETH.** An x402 payment is an EIP-3009 authorization the facilitator submits, so the payer needs USDC and no gas at all. `wallet balance` exits `46` on a zero token balance and never on a zero gas balance. Conflating the two is how "insufficient funds for gas" gets read as "x402 needs ETH".
- **A configured proxy that Node is ignoring is now named.** Node's `fetch` does not read `HTTPS_PROXY` unless started with `--use-env-proxy`, so on a proxied machine every request failed with a bare 403 or connection error that said nothing about the proxy. Network errors now say which proxy is set and how to enable it.
