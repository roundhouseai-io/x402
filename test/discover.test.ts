import { describe, it, expect, afterEach, vi } from 'vitest';
import { DEFAULT_CONFIG, mergeDeep, type X402Config } from '../src/core/config.js';
import { discover, filterByAllowlist, capabilityOf, resolveTarget } from '../src/core/discover.js';
import { ExitCode, X402Error } from '../src/core/errors.js';

const PAY_TO = '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd';

function config(override: unknown = {}): X402Config {
  return mergeDeep(DEFAULT_CONFIG, override);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** One entry as the Roundhouse index returns it. */
const endpoint = (over: Record<string, unknown> = {}) => ({
  service_name: 'lei',
  resource: 'https://provider.example/v1/lei',
  price_usdc: '0.01',
  pay_to: PAY_TO,
  is_live: true,
  http_status: 200,
  l30_unique_payers: 12,
  ...over,
});

let calledUrls: string[] = [];

function stubIndex(body: unknown, status = 200) {
  calledUrls = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    calledUrls.push(String(input instanceof Request ? input.url : input));
    return jsonResponse(status, body);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('capabilityOf', () => {
  it('recognises capability URIs and passes URLs through', () => {
    expect(capabilityOf('x402:lei')).toBe('lei');
    expect(capabilityOf('x402://lei')).toBe('lei');
    expect(capabilityOf('https://provider.example/v1/lei')).toBeUndefined();
  });
});

describe('discover', () => {
  it('queries the index at /endpoints?q= and maps the response fields', async () => {
    stubIndex({ endpoints: [endpoint()] });

    const providers = await discover('lei', config());

    expect(calledUrls).toEqual(['https://www.roundhouse.studio/api/v0/endpoints?q=lei']);
    expect(providers).toEqual([
      {
        url: 'https://provider.example/v1/lei',
        capability: 'lei',
        price: '0.01',
        asset: 'USDC',
        chain: undefined,
        payTo: PAY_TO,
        successRate: undefined,
        latencyMsP50: undefined,
        updatedAt: undefined,
        live: true,
        httpStatus: 200,
        payers30d: 12,
        source: 'index',
      },
    ]);
  });

  it('trims a trailing slash off the configured base URL', async () => {
    stubIndex({ endpoints: [] });
    await discover('lei', config({ discover: { indexUrl: 'https://index.example/api/v0/' } }));
    expect(calledUrls).toEqual(['https://index.example/api/v0/endpoints?q=lei']);
  });

  it('sorts live providers ahead of down ones, cheapest first within each', async () => {
    stubIndex({
      endpoints: [
        endpoint({ resource: 'https://a.example/lei', price_usdc: '0.05' }),
        endpoint({ resource: 'https://b.example/lei', price_usdc: '0.001', is_live: false }),
        endpoint({ resource: 'https://c.example/lei', price_usdc: '0.02' }),
      ],
    });

    const providers = await discover('lei', config());

    expect(providers.map((p) => p.url)).toEqual([
      'https://c.example/lei',
      'https://a.example/lei',
      'https://b.example/lei',
    ]);
  });

  it('still reads the camelCase and bare-array shapes', async () => {
    stubIndex([{ url: 'https://provider.example/v1/lei', price: '0.01', payTo: PAY_TO }]);

    const providers = await discover('lei', config());

    expect(providers).toHaveLength(1);
    expect(providers[0]?.url).toBe('https://provider.example/v1/lei');
    expect(providers[0]?.price).toBe('0.01');
    expect(providers[0]?.payTo).toBe(PAY_TO);
    // No price_usdc, so no asset is assumed.
    expect(providers[0]?.asset).toBeUndefined();
  });

  it('drops entries with no endpoint URL', async () => {
    stubIndex({ endpoints: [endpoint({ resource: undefined }), endpoint()] });
    expect(await discover('lei', config())).toHaveLength(1);
  });

  it('fails with the queried URL when the index errors', async () => {
    stubIndex({ error: 'nope' }, 503);
    await expect(discover('lei', config())).rejects.toThrow(/HTTP 503.*endpoints\?q=lei/);
  });
});

describe('filterByAllowlist', () => {
  it('applies the domain and payTo allowlists', async () => {
    stubIndex({
      endpoints: [
        endpoint({ resource: 'https://allowed.example/lei' }),
        endpoint({ resource: 'https://blocked.example/lei' }),
      ],
    });

    const cfg = config({ allowlist: { domains: ['allowed.example'], payTo: [PAY_TO] } });
    const filtered = filterByAllowlist(await discover('lei', cfg), cfg);

    expect(filtered.map((p) => p.url)).toEqual(['https://allowed.example/lei']);
  });
});

describe('resolveTarget', () => {
  it('prefers a pin over the index', async () => {
    stubIndex({ endpoints: [endpoint()] });

    const resolved = await resolveTarget(
      'x402:lei',
      config({ pins: { lei: 'https://pinned.example/lei' } }),
    );

    expect(resolved.url).toBe('https://pinned.example/lei');
    expect(resolved.provider?.source).toBe('pin');
    expect(calledUrls).toEqual([]);
  });

  it('never auto-routes to an endpoint the index last saw down', async () => {
    stubIndex({
      endpoints: [
        endpoint({
          resource: 'https://cheap-but-down.example/lei',
          price_usdc: '0.001',
          is_live: false,
        }),
        endpoint({ resource: 'https://up.example/lei', price_usdc: '0.02' }),
      ],
    });

    const resolved = await resolveTarget('x402:lei', config());

    expect(resolved.url).toBe('https://up.example/lei');
  });

  it('reports how many allowed providers are down when none can be used', async () => {
    stubIndex({ endpoints: [endpoint({ is_live: false })] });

    const err = await resolveTarget('x402:lei', config()).catch((e) => e);

    expect(err).toBeInstanceOf(X402Error);
    expect((err as X402Error).code).toBe(ExitCode.GENERIC);
    expect((err as Error).message).toMatch(/1 allowed provider\(s\) are down/);
  });

  it('passes a plain URL straight through without touching the index', async () => {
    stubIndex({ endpoints: [endpoint()] });
    const resolved = await resolveTarget('https://provider.example/v1/lei', config());
    expect(resolved).toEqual({ url: 'https://provider.example/v1/lei' });
    expect(calledUrls).toEqual([]);
  });
});
