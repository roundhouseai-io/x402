import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Hermetic by construction: `setupFiles` clears the proxy variables before
    // any test runs. Without it, a developer with HTTPS_PROXY set would have
    // `request()` take the real CONNECT tunnel past every stubbed `fetch`, and
    // the suite would quietly start using the network — which it must never do.
    setupFiles: ['./test/setup-env.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // `index.ts` is a re-export barrel; there is nothing in it to execute.
      exclude: ['src/index.ts'],
      reporter: ['text-summary', 'text', 'json-summary', 'lcov'],
      // A floor, not a target: CI fails if a change drops coverage below what
      // the suite already reaches. Raise these when the suite grows; never
      // lower them to make a PR pass. `npm run test:coverage` enforces them.
      thresholds: {
        lines: 75,
        statements: 75,
        functions: 80,
        branches: 72,
      },
    },
  },
});
