# CLAUDE.md

Guidance for Claude Code and other agents working in this repository. Humans should read it too — it is the map of the repo and the list of rules that must not be broken quietly.

## What this is

`@roundhouseai/x402` is a CLI that makes x402-paid HTTP requests in one command. It runs the whole payment loop (request → 402 → gate → sign → retry → receipt), delegates all signing to a pluggable **signer backend** ([OWS](https://github.com/open-wallet-standard) is the reference one, not a dependency), enforces spend limits, and records every call in a local ledger.

The primary user is an **agent**, not a human. Machine-readable output, stable exit codes, idempotent retries and predictable failure modes matter more than pretty output.

The design contract lives in [`docs/SPEC.md`](docs/SPEC.md). Read it before changing behaviour. Where the implementation knowingly departs from the spec, it is listed in [`docs/spec-deviations.md`](docs/spec-deviations.md) — add to that file rather than silently diverging.

## Repository layout

```
src/
  cli.ts                 argv → command dispatch, help text, exit-code reporting
  index.ts               library exports (serve, tests and embedders use these)
  version.ts             VERSION, read from package.json
  core/
    args.ts              flag table + parser (handles --data.<path>, aliases, --)
    assets.ts            chain/asset tables, atomic ↔ decimal conversion
    authcache.ts         signed-authorization cache (the double-payment defence)
    config.ts            config layering, env: indirection, dotted get/set
    data.ts              dot-path flags, --json, stdin, coercion, query flattening
    discover.ts          Roundhouse index queries, capability (x402:<cap>) resolution
    eip3009.ts           TransferWithAuthorization typed data, X-PAYMENT encoding
    engine.ts            the payment loop; shared by the CLI and `serve`
    errors.ts            ExitCode table + X402Error (the stability contract)
    gates.ts             allowlist → --max → session budget → daily cap
    http.ts              fetch wrapper with hard timeouts
    ids.ts               ULID, sha256 helpers, EIP-3009 nonces
    keystore.ts          scrypt + AES-256-GCM keystore for the `local` backend
    ledger.ts            JSONL ledger: append, query, group, sum
    output.ts            envelope vs human output, --raw, --out
    ows.ts               OWS HTTP client, error → exit-code mapping
    paths.ts             ~/.x402 layout, 0600/0700 file creation
    signer.ts            the SignerBackend interface (spec §5.3)
    signers/index.ts     backend registry, capability gate, x402-signer-* discovery
    signers/local.ts     encrypted-keystore backend (development and CI only)
    signers/exec.ts      external signer protocol, JSON over stdio
    stdin.ts             non-blocking stdin detection
    telemetry.ts         payload levels, redaction, remote sink + outbox
    x402.ts              402 payload parsing (compat shim) and option selection
  commands/              one file per command surface; thin over core/
  serve/
    http.ts              the unified HTTP endpoint (spec §10.1)
    mcp.ts               MCP server over stdio (JSON-RPC 2.0, no SDK dependency)
    tokens.ts            caller tokens: hashed at rest, per-token budgets
test/                    vitest; mirrors src/ concerns, not its file tree
tools/oxlint/anti-slop/  vendored lint rules, maintained here (docs/linting.md)
docs/                    spec, architecture, operational docs
.github/                 issue forms, workflows, labels, CODEOWNERS
```

Runtime state lives outside the repo, under `~/.x402/` (override with `X402_HOME`, which every test does):

```
~/.x402/config.json      user config          0600
~/.x402/ledger.jsonl     append-only ledger   0600
~/.x402/authcache/*.json signed authorizations 0600 in a 0700 dir
~/.x402/outbox/*.jsonl   telemetry awaiting a sink
~/.x402/tokens.json      hashed serve caller tokens 0600
~/.x402/keystore.json    encrypted dev keys (`local` backend) 0600
```

## Invariants

These are not preferences. Breaking one is a breaking change to the product, and a PR that does it without saying so should be rejected.

1. **No raw private keys.** There is no `--private-key`. Keys never appear in argv, env vars, or logs. Development keys live only in the `local` backend's encrypted keystore, which is read from a file, refuses a group- or world-readable one, and warns on stderr at every signature. `ethers` stays an _optional_ peer dependency, so a default install carries no signing code at all.
2. **The engine never signs, and never sees a key.** All signing goes through a `SignerBackend` (`core/signer.ts`), which receives one EIP-712 payload and nothing else — no URL, no request body, no response body. A backend that declares it cannot sign typed data is rejected when the signer is resolved (exit 47), not mid-payment. If a backend denies, the call fails: no fallback signing path, and no automatic fallback to another backend.
3. **Exit codes are a stability contract.** `src/core/errors.ts` may gain codes; it may never renumber or repurpose one. The same taxonomy is surfaced as `errorCode` on the HTTP and MCP surfaces.
4. **Telemetry defaults to `hash`.** Plaintext payload capture (`full`) is opt-in per call. Auth-like headers (`Authorization`, `X-Api-Key`, `Cookie`, `X-PAYMENT`, …) are redacted at _every_ level; only their presence is recorded.
5. **State files are 0600, state dirs 0700.** Use `writePrivate`/`appendPrivate`/`ensureDir` from `core/paths.ts`; never raw `writeFileSync` for anything under `~/.x402`.
6. **The authorization cache is the double-payment defence.** Never sign without first checking it (unless `--no-cache`), and never widen its key so that a retry misses. See [`docs/idempotency.md`](docs/idempotency.md).
7. **Gate order is fixed:** domain/payTo allowlist → `--max` → session `--budget` → daily cap → the backend's policy layer. First failure aborts, and CLI-side gates never make a network call before failing.
8. **Zero runtime dependencies.** The CLI ships with none, on purpose: it is a payments tool, and every dependency is supply-chain risk against a hot wallet. Adding one needs an issue and a maintainer's agreement first — Node 20+ built-ins cover HTTP, crypto and JSON-RPC.

## Working here

```bash
npm install
npm run typecheck     # tsc --noEmit over src + test
npm run lint          # oxlint + vendored anti-slop rules over src + test (needs Node 22)
npm test              # vitest run (146 tests, no network)
npm run build         # tsc → dist/
npm run format:check  # prettier
node dist/cli.js --help
npm run dev -- probe https://example.com/v1/thing   # tsx, no build step
```

Before pushing, run `npm run typecheck && npm run lint && npm test && npm run format:check`. CI runs the same checks, on Node 20 and 22 — except `lint`, which runs once on Node 22 because its config is TypeScript and Node 20 cannot load it.

`lint` fails only on the rules the codebase already satisfies; the rest report as warnings. Do not demote a rule to make it pass — see [`docs/linting.md`](docs/linting.md).

Tests never touch the network and never touch a real `~/.x402`: they stub `fetch` and point `X402_HOME` at a temp dir. Keep it that way. When a test needs a signer, implement the small `Signer` interface rather than mocking OWS over HTTP.

## How to make common changes

- **A new command.** Add `src/commands/<name>.ts`, register it in `COMMANDS` in `core/args.ts` and in the `switch` in `cli.ts`, document it in the help text, `README.md` and `SKILL.md`. Commands parse flags and print; the logic belongs in `core/`.
- **A new flag.** Add it to the `FLAGS` table in `core/args.ts` with the right kind, or the parser will mis-handle it (a `boolean` declared as `string` eats the next argument).
- **A new chain or asset.** Extend `CHAINS`/`ASSETS` in `core/assets.ts`, including the EIP-712 domain name/version for the token contract. Nothing else should hard-code a chain id.
- **A new signer backend.** Implement `SignerBackend` in `core/signers/<name>.ts`, register it in `BUILTIN_BACKENDS` and the `construct` switch in `core/signers/index.ts`, and document it in `docs/signers.md`. Declare capabilities honestly and map failures onto 42/46/47 — that mapping is what agents act on. Out-of-tree backends need no changes here: they publish as `x402-signer-<name>` exporting `createSigner({ config, wallet })`.
- **A provider whose 402 payload does not parse.** Add the key alias to the `A_*` lists in `core/x402.ts` and a case to `test/x402.test.ts`. File the provider under the `provider-compat` issue form so the shim stays evidence-driven.
- **A new gate.** Put it in `core/gates.ts` in the documented order, give it an exit code, and add it to `docs/exit-codes.md`.
- **Anything the agent surface can see.** Update `SKILL.md`. It is the agent-facing contract and drifting from it is a bug.

## Repository process

- **Branches:** `claude/<topic>` for agent work, `feat/<topic>`, `fix/<topic>` otherwise. `main` is protected; every change lands by PR.
- **Commits:** imperative subject, no model or tool names in the message.
- **Issues:** use the forms in `.github/ISSUE_TEMPLATE/`. Labels are declared in `.github/labels.yml` and synced by a workflow — add labels there, not by hand in the UI.
- **Releases:** [Changesets](https://github.com/changesets/changesets) → npm + a GitHub Release. Every user-visible PR carries a changeset (`npx changeset`); **merging it to `main` publishes**, with no approval step in between, so the changeset's bump is a reviewable part of the PR. Full process in [`docs/releasing.md`](docs/releasing.md). Do not bump the version in `package.json` by hand and do not publish from a laptop; CI publishes with npm provenance.
- **Security:** never open a public issue for a spend-affecting bug. See `SECURITY.md`.

## Known open questions

Seven questions block v1 and are tracked as issues; they are listed in [`docs/roadmap.md`](docs/roadmap.md). **OWS must expose EIP-712 typed-data signing** (`signTypedData`): its published core types show `signMessage` with `utf8`/`hex` only, and EIP-3009 cannot be signed with either. `core/ows.ts` calls `POST /v1/wallets/:wallet/sign-typed-data` and maps a 404/405/501 onto a clear exit 47. Since the signer abstraction landed this no longer blocks the tool — `local` and `exec` work today — but it does block OWS as the flagship backend. Two newer questions matter before the interface sets: reviewing prior art (Solana's `pay` describes a similar wallet-backend split) and pinning down the `exec` protocol, drafted in [`docs/exec-signer.md`](docs/exec-signer.md).

Also note a bare `npx x402` cannot resolve to this package: the unscoped `x402` name on npm belongs to another project. The zero-install form is `npx @roundhouseai/x402 <url>`; a global install still gives you the `x402` binary. Do not write docs that promise otherwise.

## Workflow gotcha worth remembering

A job-level `permissions:` block in a GitHub Actions workflow **replaces** the workflow-level one; it does not merge. A job that needs `contents: read` must say so even when the workflow already grants it, or `actions/checkout` fails with `remote: Repository not found` — which reads like a missing repo rather than a missing scope. `.github/workflows/codeql.yml` learned this the hard way.
