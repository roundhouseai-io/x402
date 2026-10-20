# Linting

[anti-slop](https://github.com/dmmulroy/anti-slop) is a set of Oxlint rules that reject low-evidence TypeScript: `unknown` in contracts, ad hoc `typeof` narrowing, undocumented type assertions, module mocking in tests. This package runs it under the same policy as the Roundhouse monorepo: **every rule is `error`, and `src/`, `test/` and `scripts/` are at zero findings.**

```bash
pnpm lint:slop        # the gate: warnings are errors, so a finding fails the command
npm run lint:slop     # the same script
npm run lint          # the same rules, without --deny-warnings
```

The gate runs in three places:

- **CI**: the `anti-slop` job in `.github/workflows/ci.yml` runs `npm run lint:slop` over the whole tree and fails on any finding.
- **Pre-commit**: `.githooks/pre-commit` lints the staged JS/TS files. `npm install` points git at `.githooks/` (`scripts/install-hooks.mjs`, run from `prepare`; it does nothing outside the root of a git checkout). Bypass a genuine false positive with `git commit --no-verify`, and say why in the PR.
- **Locally**: `pnpm lint:slop` or `npm run lint:slop`.

**Linting needs Node 22.** `oxlint.config.ts` is TypeScript, loaded through Node's type stripping, which Node 20 does not have. The package still supports Node 20 and CI still tests on it; lint runs once, on Node 22. On Node 20 the pre-commit hook says so and skips, and CI enforces the gate.

## Vendored, with attribution

The plugin is vendored under `tools/oxlint/anti-slop/` (including `effect/`), copied from the Roundhouse monorepo's copy of [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop). It is MIT-licensed, © Dillon Mulroy; the licence travels with the code at `tools/oxlint/anti-slop/LICENSE`. Vendoring is how upstream means it to be used: upstream cannot change what this repo enforces without a visible commit here. `oxlint` and `@oxlint/plugins` are devDependencies, so the published tarball is unaffected and the zero-runtime-dependency invariant holds.

Prettier does not format the vendored directory, so a future re-vendor is a clean diff.

## The one override

`test/**/*.test.ts` turns off `no-chained-type-assertions` and `require-safety-comment-for-type-assertion`, the same exemption the monorepo makes. Tests fabricate invalid values on purpose (malformed 402s, forged payloads, a signer that lies) to prove they are rejected, so an assertion there is the point of the test, not a claim about production data. Every other rule, including `no-module-mocking`, applies to tests: the suite uses dependency injection and a stubbed global `fetch`, never `vi.mock`.

## Fix patterns, best first

1. **Delete the assertion.** Most `as X` were unnecessary once the input had a real type.
2. **Name the real type**, or use `satisfies`. A named interface (`HeaderMap`, `ConfigEntries`, `TypedDataTypes`) instead of an anonymous `Record<string, …>` annotation on a literal.
3. **A named type predicate** at the boundary. `src/core/json.ts` holds the JSON vocabulary (`JsonValue`, `JsonObject`, `parseJson`) and the generic guards (`isJsonObject`, `isString`, `isNumber`, …). Each domain shape read from disk or the network has its own guard next to its type: `isLedgerRecord`, `isKeystoreEntry`, `isAuthCacheEntry`, `isCallerToken`, `isPaymentPayload`, `isSettlementResponse`, `isJsonRpcRequest`. Guards are generic (`<T>(value: T): value is T & X`); the only `unknown` parameters left are ones named `cause`, which the rule exempts, because a caught exception really can be anything (`messageOf`, `exitCodeOf`, `errnoCode`).
4. **`Map` for runtime keys.** The flag table and alias table in `core/args.ts` are `Map`s, so `--constructor` cannot reach `Object.prototype`.
5. **A `SAFETY:` comment**, last, stating the invariant and what enforces it. Two remain, both in `core/config.ts` on the generic `mergeDeep` and `resolveEnv`, and each names the checks (`assertGroupsAreObjects`, `normalizeAmounts`, `assertKnownConfigKey`) that make the claim true.

Conditional spreads (`...(x ? { a: x } : {})`) are rewritten as statements on a typed object.

## Changing the rules

Do not add an override, a `warn`, or a disable comment to land code. Fix the finding. If a rule is wrong somewhere, say so in the PR and turn it off for exactly that file with a comment explaining why, the way the monorepo does for SVG "shape" names. A rule set that gets edited to make CI pass is not doing its job.
