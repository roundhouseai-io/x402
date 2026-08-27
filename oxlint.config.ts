import { defineConfig } from 'oxlint';

// anti-slop (https://github.com/dmmulroy/anti-slop, MIT) is vendored under
// tools/oxlint/anti-slop and maintained here rather than tracked as a
// dependency, which is how it is meant to be used.
//
// Rules the codebase already satisfies are `error`, so CI blocks a regression.
// The rest are `warn`: they are real findings, but clearing them is a refactor
// of the 402 and config paths rather than a rename, and some conflict with the
// zero-runtime-dependency invariant. docs/linting.md has the counts, the
// reasoning per rule, and how the list ratchets.
export default defineConfig({
  ignorePatterns: ['.claude/**', 'dist/**', 'node_modules/**', 'tools/oxlint/anti-slop/**'],
  jsPlugins: [{ name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' }],
  rules: {
    // Clean today. These block a regression rather than describing a backlog.
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-widen-then-assert': 'error',

    // Outstanding. Counts and rationale in docs/linting.md; promote as cleared.
    'anti-slop/no-chained-type-assertions': 'warn',
    'anti-slop/no-conditional-empty-object-spread': 'warn',
    'anti-slop/no-known-value-widening': 'warn',
    'anti-slop/no-runtime-typeof': 'warn',
    'anti-slop/no-unknown-parameters': 'warn',
    'anti-slop/no-unknown-returns': 'warn',
    'anti-slop/no-unsafe-dictionary-type': 'warn',
    'anti-slop/require-safety-comment-for-type-assertion': 'warn',
  },
});
