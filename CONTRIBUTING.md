# Contributing

Thanks for looking. This is a tool that spends money on behalf of agents, so the bar for changes to the payment path is higher than for a normal CLI — but most of the work here is ordinary, and small PRs are welcome.

Start with [`CLAUDE.md`](CLAUDE.md) for the repo map and the invariants, and [`docs/SPEC.md`](docs/SPEC.md) for the design contract.

## Setup

```bash
git clone https://github.com/roundhouseai-io/x402
cd x402
npm install
npm test
```

Node 20.10+ is required. There are no runtime dependencies and only a handful of dev ones.

```bash
npm run typecheck      # tsc --noEmit over src + test
npm test               # vitest run; no network, no real ~/.x402
npm run build          # tsc → dist/
npm run format:check   # prettier
npm run dev -- probe https://example.com/thing   # run from source via tsx
```

Run `npm run typecheck && npm test && npm run format:check` before pushing. CI runs exactly that, on Node 20 and 22, plus the quality gates below.

### Quality gates

`.github/workflows/quality-gates.yml` runs on every PR, alongside `ci.yml`:

| Gate              | Run it locally                                      | Fails when                                                     |
| ----------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Coverage          | `npm run test:coverage`                             | coverage drops below the floors in `vitest.config.ts`          |
| Secret scan       | `gitleaks git --log-opts=--all -c .gitleaks.toml .` | gitleaks finds a credential anywhere in history or the tree    |
| Unicode safety    | `npm run check:unicode`                             | a zero-width, Tag-block or bidi-control character is committed |
| No personal paths | `npm run check:paths`                               | a `/Users/<name>` or `/home/<name>` path is committed          |
| Workflow security | `npm run check:workflows`                           | a workflow lacks `permissions:` or interpolates untrusted text |
| Markdown          | `npx markdownlint-cli2 "**/*.md"`                   | a doc breaks `.markdownlint.json`                              |

`npm run check` runs the three local scripts in one go. `npm run lint` (anti-slop) needs Node 22.

## The rules that are not negotiable

These come from the security model, not from taste. A PR that breaks one without saying so will be sent back:

1. **No private keys.** No `--private-key` flag, no key in an environment variable, no key in a log line. The one development path (the `local` keystore, which imports from a `--key-file` and refuses a world-readable one) stays file-only, encrypted at rest and permission-checked.
2. **No fallback signing.** If the wallet layer denies or is unreachable, the call fails.
3. **Exit codes are append-only.** Never renumber or repurpose one; agents branch on them.
4. **Telemetry stays `hash` by default,** and auth-like headers stay redacted at every level.
5. **State files are 0600, directories 0700.** Use the helpers in `core/paths.ts`.
6. **The authorization cache stays intact.** Any change to its key needs an argument for why a retry still hits it.
7. **Zero runtime dependencies.** Adding one needs an issue and a maintainer's agreement first.

## Writing the change

- Code goes in `src/core/` (logic) or `src/commands/` (parse flags, print, exit). Commands should be thin.
- Match the surrounding style: explicit types on exported functions, comments that explain _why_ rather than restating the code, no defensive noise.
- Tests are vitest, in `test/`, organised by concern. Stub `fetch`; point `X402_HOME` at a temp dir; implement the `Signer` interface rather than mocking OWS over HTTP.
- Anything touching money needs a test that proves the money did **not** move on the failure path.
- Update the docs in the same PR: `README.md` for user-visible behaviour, `SKILL.md` for anything an agent sees, `docs/exit-codes.md` for a new code, `docs/spec-deviations.md` if you depart from the spec.

## Changesets

Every user-visible PR carries one:

```bash
npx changeset
```

Pick the bump (see [`docs/releasing.md`](docs/releasing.md) for what counts as major/minor/patch) and write the summary as a changelog line. Docs-only, CI-only and test-only PRs can skip it; add the `release: skip` label so the omission is deliberate rather than forgotten.

## Pull requests

- One concern per PR. A parser fix and a new flag are two PRs.
- Fill in the template: what changed, why, how you tested it, and whether it touches the payment path.
- CI must be green. If a check fails for reasons unrelated to your change, say so in the PR rather than pushing an empty commit.
- Reviews focus on the payment path, the exit-code contract, and whether the failure modes are still predictable.

## Reporting things

- **Bugs, provider incompatibilities, feature ideas:** use the issue forms. A `provider-compat` report with the raw 402 payload is the single most useful thing you can file — it is what makes the parser shim evidence-driven rather than guesswork.
- **Anything that could cost someone money:** do not open a public issue. Follow [`SECURITY.md`](SECURITY.md).

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
