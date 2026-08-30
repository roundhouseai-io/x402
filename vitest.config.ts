import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Hermetic by construction: `setupFiles` clears the proxy variables before
    // any test runs. Without it, a developer with HTTPS_PROXY set would have
    // `request()` take the real CONNECT tunnel past every stubbed `fetch`, and
    // the suite would quietly start using the network — which it must never do.
    setupFiles: ['./test/setup-env.ts'],
  },
});
