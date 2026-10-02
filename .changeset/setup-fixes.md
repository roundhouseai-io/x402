---
'@roundhouseai/x402': minor
---

Smaller changes that the guided setup builds on.

- `wallet balance --wait --min <usdc> --timeout <duration>` polls the chain until the wallet is funded. Exit `0` when met, new exit code `48` (`wait_timeout`) when it times out. `--min` alone checks once and exits `46` if short.
- `config set auth.apiKey` stores a Roundhouse API key (an `env:NAME` reference, `-` for stdin, or a literal). It is sent as `Authorization: Bearer` to `roundhouseai.io` hosts only, and is redacted in `config get`, `config list` and `status`.
- `discover --policy` applies the default counterparty rule (live, at least one payer in 30 days, price at or under 1.5 times spot) and lists the offers it excluded with the reason. `--spot-factor` changes the factor.
- `rh-x402 help exit-codes` prints one table with a "what to do next" column (`--markdown`, `--json`). The help footer, `SKILL.md` and `docs/exit-codes.md` now draw on it.
- The guided setup refuses to run `npm i -g` into a directory the user cannot write, and says to use `npx` or a project install, never `sudo`.
- Importing `cli.ts` no longer runs the CLI.
