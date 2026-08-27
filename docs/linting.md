# Linting

[anti-slop](https://github.com/dmmulroy/anti-slop) is a set of Oxlint rules that reject low-evidence TypeScript: `unknown` in contracts, ad hoc `typeof` narrowing, undocumented type assertions. It runs over `src/` and `test/` on every PR.

```bash
npm run lint          # what CI runs: enforced rules fail, the rest report
npm run lint:strict   # treat every finding as an error, for local cleanup work
```

The plugin is **vendored** under `tools/oxlint/anti-slop/`, which is how it is meant to be used — copy it in, read it, change it. It is not an npm dependency, so upstream cannot change what this repo enforces without a visible commit here. `oxlint` and `@oxlint/plugins` are devDependencies; the published tarball is unaffected and the zero-runtime-dependency invariant still holds.

Prettier does not format the vendored directory: it is upstream's code, kept as upstream ships it, so a future re-vendor is a clean diff.

## Two tiers

**Enforced** — rules the codebase already satisfies. CI fails on a violation, so these block a regression rather than describing a backlog.

`no-module-mocking` · `no-object-parameters` · `no-reflect-apply` · `no-reflect-get` · `no-shape-in-symbol-names` · `no-unknown-type-aliases` · `no-widen-then-assert`

`no-module-mocking` being clean is not an accident: `CLAUDE.md` already asks for a real `Signer` implementation over a mocked OWS, and the test suite follows that.

**Outstanding** — real findings, reported on every PR and counted in the job summary, but not blocking. Clearing them is a refactor of the 402 and config paths, not a rename.

| Count | Rule                                        | Why it is not enforced yet                                                                                                                                    |
| ----: | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   105 | `require-safety-comment-for-type-assertion` | Each needs a `SAFETY:` comment stating the checked invariant. Mechanical, but 105 of them, and a comment written to silence a linter is worse than none.      |
|    48 | `no-runtime-typeof`                         | See below.                                                                                                                                                    |
|    44 | `no-unsafe-dictionary-type`                 | See below.                                                                                                                                                    |
|    44 | `no-unknown-parameters`                     | See below.                                                                                                                                                    |
|    26 | `no-conditional-empty-object-spread`        | `...(x ? { a: x } : {})`. Genuinely clearer rewritten; a contained cleanup.                                                                                   |
|    13 | `no-known-value-widening`                   | Explicit broad types where inference or `satisfies` would keep the evidence.                                                                                  |
|    10 | `no-unknown-returns`                        | Mostly boundary decoders that really do return an unvalidated payload.                                                                                        |
|     8 | `no-chained-type-assertions`                | Five are `as unknown as T` inside the generic deep-merge and `env:` resolver in `core/config.ts`. Removing them means restructuring those generic signatures. |

Run `npm run lint` for the current numbers; the table is a snapshot.

## The one real disagreement

Three rules — `no-runtime-typeof`, `no-unknown-parameters`, `no-unsafe-dictionary-type`, 136 findings between them — say the same thing: do not accept `unknown`, do not narrow with `typeof`, parse at the boundary into a domain type instead. That is right, and it is what `core/x402.ts` and `core/discover.ts` are already doing by hand.

The rules assume a schema library is available to do it. This package [ships with zero runtime dependencies on purpose](../CLAUDE.md) — it is a payments tool, and every dependency is supply-chain risk against a hot wallet. So the boundary parsers are hand-written, and a hand-written parser reads as `typeof v === 'string'` over a `Record<string, unknown>`. The rule sees the shape it rejects; the code is doing the thing the rule wants.

Resolving that means extracting the ad hoc checks into named decoders with domain return types — worth doing, and a change to the 402 parser is a change to the code that decides what gets paid. It belongs in its own PR with its own tests, not folded into an unrelated one.

## Changing the rules

Promote a rule to `error` in `oxlint.config.ts` in the same PR that clears the last violation, so it can never come back. Never demote one to clear a PR: fix the finding, or say in the PR why the rule is wrong here and turn it off deliberately with a comment. A rule set that is edited to make CI green is not a rule set.
