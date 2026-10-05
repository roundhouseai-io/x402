/**
 * Proxy variables are cleared for the whole suite.
 *
 * `core/http.ts` routes an HTTPS request through a CONNECT tunnel whenever one
 * is configured, which bypasses a stubbed `fetch` entirely. On a machine with
 * `HTTPS_PROXY` set — CI runners and corporate laptops both — that would turn
 * unit tests into live network calls against real endpoints.
 *
 * Tests that care about proxy behaviour pass an explicit environment to
 * `proxyFromEnv` / `proxyHint` rather than relying on the ambient one.
 */
for (const name of [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
]) {
  delete process.env[name];
}
