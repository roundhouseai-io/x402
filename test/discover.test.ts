import { describe, it, expect, afterEach, vi } from 'vitest';
import { DEFAULT_CONFIG, mergeDeep, type X402Config } from '../src/core/config.js';
import {
  discover,
  discoverMarket,
  filterByAllowlist,
  capabilityOf,
  resolveTarget,
} from '../src/core/discover.js';
import { ExitCode, X402Error } from '../src/core/errors.js';

const PAY_TO = '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function config(override: unknown = {}): X402Config {
  return mergeDeep(DEFAULT_CONFIG, override);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** One entry shaped exactly as the live Roundhouse index returns it. */
const endpoint = (over: Record<string, unknown> = {}) => ({
  resource: 'https://provider.example/v1/lei',
  service_name: 'lei',
  description: 'Legal entity identifier lookup.',
  icon_url: null,
  tags: [],
  network: 'eip155:8453',
  pay_to: PAY_TO,
  asset: USDC_BASE,
  scheme: 'exact',
  price_usdc: '0.01',
  l30_total_calls: 34,
  l30_unique_payers: 12,
  is_live: true,
  onchain_volume_usdc: null,
  ...over,
});

let calledUrls: string[] = [];

/**
 * Route by URL: `unified.json` and `/endpoints` are different surfaces and the
 * code tries them in that order.
 */
function stubRoutes(routes: { unified?: [number, unknown]; endpoints?: [number, unknown] }) {
  calledUrls = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    calledUrls.push(url);
    // The two surfaces are told apart by their query param, not their host:
    // unified.json takes `?capability=`, the keyword search takes `?q=`.
    const [status, body] = url.includes('capability=')
      ? (routes.unified ?? [404, { error: 'unknown_capability' }])
      : (routes.endpoints ?? [404, { error: 'not found' }]);
    return jsonResponse(status, body);
  });
}

/** The capability is not a registered slug, so only `/endpoints` answers. */
function stubIndex(body: unknown, status = 200) {
  stubRoutes({ endpoints: [status, body] });
}

/** The capability is a registered slug, so `unified.json` answers. */
function stubUnified(body: unknown, status = 200) {
  stubRoutes({ unified: [status, body] });
}

const endpointsUrl = (cap = 'lei') => `https://www.roundhouse.studio/api/v0/endpoints?q=${cap}`;
const unifiedUrl = (cap = 'lei') => `https://www.roundhouse.studio/unified.json?capability=${cap}`;

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

    // unified.json is asked first; an unknown slug falls back to /endpoints.
    expect(calledUrls).toEqual([unifiedUrl(), endpointsUrl()]);
    expect(providers).toEqual([
      {
        url: 'https://provider.example/v1/lei',
        capability: 'lei',
        price: '0.01',
        // CAIP-2 and the contract address normalise to the names the 402 parser uses.
        asset: 'usdc',
        chain: 'base',
        payTo: PAY_TO,
        successRate: undefined,
        latencyMsP50: undefined,
        updatedAt: undefined,
        live: true,
        calls30d: 34,
        payers30d: 12,
        source: 'index',
      },
    ]);
  });

  it('trims a trailing slash off the configured base URL', async () => {
    stubIndex({ endpoints: [] });
    await discover('lei', config({ discover: { indexUrl: 'https://index.example/api/v0/' } }));
    expect(calledUrls.at(-1)).toBe('https://index.example/api/v0/endpoints?q=lei');
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

  it('keeps a free endpoint priced at zero, and sorts it first', async () => {
    stubIndex({
      endpoints: [
        endpoint({ resource: 'https://paid.example/lei', price_usdc: '0.01' }),
        endpoint({ resource: 'https://free.example/lei', price_usdc: 0 }),
      ],
    });

    const providers = await discover('lei', config());

    expect(providers.map((p) => p.url)).toEqual([
      'https://free.example/lei',
      'https://paid.example/lei',
    ]);
    // Zero is a price, not a missing one: it must not fall through to `undefined`.
    expect(providers[0]?.price).toBe('0');
    expect(providers[0]?.asset).toBe('usdc');
  });

  it('sorts an unpriced provider after every priced one', async () => {
    stubIndex({
      endpoints: [
        endpoint({ resource: 'https://unpriced.example/lei', price_usdc: undefined }),
        endpoint({ resource: 'https://dear.example/lei', price_usdc: '9.99' }),
      ],
    });

    expect((await discover('lei', config())).map((p) => p.url)).toEqual([
      'https://dear.example/lei',
      'https://unpriced.example/lei',
    ]);
  });

  it('treats an index that reports no liveness as routable', async () => {
    stubIndex({
      endpoints: [
        endpoint({ resource: 'https://b.example/lei', price_usdc: '0.05', is_live: undefined }),
        endpoint({ resource: 'https://a.example/lei', price_usdc: '0.01', is_live: undefined }),
      ],
    });

    const providers = await discover('lei', config());

    expect(providers.every((p) => p.live === undefined)).toBe(true);
    expect(providers.map((p) => p.url)).toEqual(['https://a.example/lei', 'https://b.example/lei']);
    // Unknown liveness must not block resolution the way `is_live: false` does.
    expect((await resolveTarget('x402:lei', config())).url).toBe('https://a.example/lei');
  });

  it('passes an unrecognised network and asset through verbatim', async () => {
    const unknownAsset = '0xdEaD00000000000000000000000000000000BEEF';
    stubIndex({ endpoints: [endpoint({ network: 'eip155:999999', asset: unknownAsset })] });

    const [p] = await discover('lei', config());

    // Neither is in the tables, so neither is renamed — and neither is dropped.
    expect(p?.chain).toBe('eip155:999999');
    expect(p?.asset).toBe(unknownAsset);
  });

  it('falls back to usdc only when the index states no asset at all', async () => {
    stubIndex({ endpoints: [endpoint({ asset: undefined })] });

    // The price came from `price_usdc`, so the asset is implied rather than read.
    expect((await discover('lei', config()))[0]?.asset).toBe('usdc');
  });

  it('fabricates nothing from null fields, and falls back for a null service_name', async () => {
    stubIndex({
      endpoints: [
        {
          resource: 'https://x.example/lei',
          service_name: null,
          price_usdc: null,
          pay_to: null,
          asset: null,
          network: null,
          is_live: null,
          l30_total_calls: null,
          l30_unique_payers: null,
        },
      ],
    });

    const [p] = await discover('lei', config());

    // The live index really does return `service_name: null` for some entries.
    expect(p?.capability).toBe('lei');
    expect(p?.price).toBeUndefined();
    expect(p?.asset).toBeUndefined();
    expect(p?.chain).toBeUndefined();
    expect(p?.payTo).toBeUndefined();
    expect(p?.live).toBeUndefined();
    expect(p?.calls30d).toBeUndefined();
    expect(p?.payers30d).toBeUndefined();
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

describe('discoverMarket', () => {
  /** Shaped as the live `unified.json?capability=web-search` document. */
  const unified = (over: Record<string, unknown> = {}) => ({
    version: '1',
    capability: {
      slug: 'web-search',
      name: 'Web search',
      group: 'Web & Content',
      summary: 'Search the open web and get ranked results.',
      unit: 'per search',
    },
    stats: {
      offers: 122,
      providers: 68,
      live: 121,
      price: {
        min: 0.001,
        median: 0.01,
        max: 0.63,
        spread: 630,
        spot: 0.01638678621659635,
        spotBasis: 'calls',
        p25: 0.005,
        p75: 0.02,
      },
    },
    offers: [
      {
        resource: 'https://blockrun.ai/api/v1/exa/search',
        service_name: 'BlockRun.AI',
        host: 'blockrun.ai',
        pay_to: PAY_TO,
        network: 'eip155:8453',
        price_usdc: 0.011,
        l30_total_calls: 2411,
        l30_unique_payers: 42,
        last_called_at: '2026-08-27T12:53:08.364+00:00',
        is_live: true,
        confidence: 'strong',
        gateway: false,
      },
    ],
    ...over,
  });

  it('prefers unified.json and returns the market stats with the offers', async () => {
    stubUnified(unified());

    const market = await discoverMarket('web-search', config());

    // Only one call: a known slug never needs the /endpoints fallback.
    expect(calledUrls).toEqual([unifiedUrl('web-search')]);
    expect(market.from).toBe('unified');
    expect(market.capability).toBe('web-search');
    expect(market.name).toBe('Web search');
    expect(market.unit).toBe('per search');
    expect(market.stats).toEqual({
      min: '0.001',
      p25: '0.005',
      median: '0.01',
      p75: '0.02',
      max: '0.63',
      spread: 630,
      spot: '0.01638678621659635',
      spotBasis: 'calls',
      offers: 122,
      providers: 68,
      live: 121,
    });
  });

  it('maps the richer fields unified.json carries', async () => {
    stubUnified(unified());

    const [p] = (await discoverMarket('web-search', config())).providers;

    expect(p?.url).toBe('https://blockrun.ai/api/v1/exa/search');
    expect(p?.price).toBe('0.011');
    expect(p?.chain).toBe('base');
    expect(p?.calls30d).toBe(2411);
    expect(p?.payers30d).toBe(42);
    expect(p?.lastCalledAt).toBe('2026-08-27T12:53:08.364+00:00');
    expect(p?.confidence).toBe('strong');
    expect(p?.gateway).toBe(false);
  });

  it('falls back to /endpoints for a capability unified.json does not know', async () => {
    stubRoutes({
      unified: [200, { error: 'unknown_capability', capability: 'lei' }],
      endpoints: [200, { endpoints: [endpoint()] }],
    });

    const market = await discoverMarket('lei', config());

    expect(calledUrls).toEqual([unifiedUrl(), endpointsUrl()]);
    expect(market.from).toBe('endpoints');
    expect(market.providers).toHaveLength(1);
    // The keyword surface carries no market-wide pricing.
    expect(market.stats).toBeUndefined();
    expect(market.unit).toBeUndefined();
  });

  it('falls back when unified.json errors rather than failing the lookup', async () => {
    stubRoutes({
      unified: [503, { error: 'upstream' }],
      endpoints: [200, { endpoints: [endpoint()] }],
    });

    const market = await discoverMarket('lei', config());

    expect(market.from).toBe('endpoints');
    expect(market.providers).toHaveLength(1);
  });

  it('only fails once both surfaces do', async () => {
    stubRoutes({ unified: [503, {}], endpoints: [503, {}] });

    await expect(discoverMarket('lei', config())).rejects.toThrow(/HTTP 503.*endpoints\?q=lei/);
  });

  it('honours a configured unifiedUrl', async () => {
    stubRoutes({ unified: [200, unified()] });

    await discoverMarket(
      'web-search',
      config({ discover: { unifiedUrl: 'https://u.example/u.json' } }),
    );

    expect(calledUrls).toEqual(['https://u.example/u.json?capability=web-search']);
  });

  it('tolerates a unified document with no stats block', async () => {
    stubUnified(unified({ stats: undefined }));

    const market = await discoverMarket('web-search', config());

    expect(market.from).toBe('unified');
    expect(market.stats).toBeUndefined();
    expect(market.providers).toHaveLength(1);
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
