import { defineConfig } from 'oxlint';

// Anti-slop lint gate: anti-slop (https://github.com/dmmulroy/anti-slop, MIT;
// licence at tools/oxlint/anti-slop/LICENSE) is vendored under
// tools/oxlint/anti-slop and maintained here rather than tracked as a
// dependency, which is how it is meant to be used. The policy is the one the
// Roundhouse monorepo runs: every rule is `error`, and the package is at zero.
// Runs via `npm run lint:slop`, in CI (ci.yml, anti-slop job) and from
// .githooks/pre-commit on staged files. docs/linting.md has the fix patterns.
//
// Adding a blanket "warn" or a new override to land code is a regression, not a
// fix. The one exception is documented at the override itself.
export default defineConfig({
  ignorePatterns: [
    '.claude/**',
    'dist/**',
    'coverage/**',
    'node_modules/**',
    'tools/oxlint/anti-slop/**',
  ],
  categories: {
    correctness: 'off',
  },
  jsPlugins: [{ name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' }],
  rules: {
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'error',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    // allowInTypeGuards is the rule's own option: it makes extracting a named
    // predicate an actual fix rather than relocating the finding to the guard.
    'anti-slop/no-runtime-typeof': ['error', { allowInTypeGuards: true }],
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-unsafe-dictionary-type': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
  },
  overrides: [
    {
      // The same exemption the Roundhouse monorepo makes: tests fabricate
      // invalid values on purpose (malformed 402s, forged payloads, a signer
      // that lies) to prove they are rejected, so an assertion there is the
      // point of the test rather than a claim about production data.
      files: ['test/**/*.test.ts'],
      rules: {
        'anti-slop/no-chained-type-assertions': 'off',
        'anti-slop/require-safety-comment-for-type-assertion': 'off',
      },
    },
  ],
});
