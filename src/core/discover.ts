import { X402Error, ExitCode } from './errors.js';
import { request, parseJsonBody } from './http.js';
import { domainAllowed } from './gates.js';
import { findChain, findAsset } from './assets.js';
import type { X402Config } from './config.js';
import { authHeaders } from './auth.js';

export interface Provider {
  url: string;
  capability: string;
  /** Human decimal price per call, when the index knows it. */
  price?: string;
  asset?: string;
  chain?: string;
  payTo?: string;
  /** Rolling success rate from fleet telemetry, 0..1. */
  successRate?: number;
  latencyMsP50?: number;
  updatedAt?: string;
  /** Index liveness: false means the last probe did not reach the endpoint. */
  live?: boolean;
  /** Settled calls over the trailing 30 days, when the index reports it. */
  calls30d?: number;
  /** Distinct payers over the trailing 30 days, when the index reports it. */
  payers30d?: number;
  /** When the index last saw this endpoint settle a call. */
  lastCalledAt?: string;
  /** The index's own confidence that this offer serves the capability. */
  confidence?: string;
  /** True when the provider resells other providers rather than serving directly. */
  gateway?: boolean;
  source: 'index' | 'pin';
}

/**
 * Capability-wide pricing, so an agent can judge one offer against the market
 * rather than against nothing. Only the capability document carries these; a
 * fallback `/endpoints` keyword search leaves them undefined.
 */
export interface MarketStats {
  /** Human decimal prices, in the capability's own unit. */
  min?: string;
  p25?: string;
  median?: string;
  p75?: string;
  max?: string;
  /** `max / min` — how far apart the cheapest and dearest offers sit. */
  spread?: number;
  /** Average price actually paid, weighted by `spotBasis` (usually calls). */
  spot?: string;
  spotBasis?: string;
  offers?: number;
  /**
   * Offers the index could and could not put a price on. The quantiles above
   * describe the priced ones only, so a large `unpriced` means the market they
   * describe is narrower than `offers` suggests.
   */
  priced?: number;
  unpriced?: number;
  providers?: number;
  live?: number;
}

/** A capability, its offers and the market they sit in. */
export interface Market {
  capability: string;
  /** Display name from the index, when it knows the capability. */
  name?: string;
  summary?: string;
  /** What one call buys, e.g. "per search". */
  unit?: string;
  providers: Provider[];
  stats?: MarketStats;
  /**
   * True when the index returned only part of the offer list. The API caps a
   * capability document at 50 offers, so on a busy capability "cheapest first"
   * is cheapest of what came back — not of the market `stats` describes.
   */
  truncated?: boolean;
  /** Which index surface answered. */
  from: 'unified' | 'endpoints';
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const priceOf = (p: Provider): number => {
  const n = Number(p.price);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

const numOrUndef = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const strOrUndef = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);

/** Dead endpoints sort last; within a liveness class, cheapest first. */
const byLivenessThenPrice = (a: Provider, b: Provider): number => {
  const rank = (p: Provider) => (p.live === false ? 1 : 0);
  return rank(a) - rank(b) || priceOf(a) - priceOf(b);
};

/** `x402:lei` -> `lei`. Returns undefined for ordinary URLs. */
export function capabilityOf(target: string): string | undefined {
  const m = /^x402:(?:\/\/)?([A-Za-z0-9._-]+)$/.exec(target.trim());
  return m ? m[1] : undefined;
}

const mapProvider = (p: Record<string, unknown>, capability: string): Provider => {
  // The index states the chain as CAIP-2 (`eip155:8453`) and the asset as a
  // contract address. Normalise both through the tables so a listing reads in
  // the same vocabulary `--chain` and `--asset` accept. These are informational:
  // the binding chain and asset come from the live 402, not from the index.
  const chain = findChain(strOrUndef(p.chain ?? p.network));
  const assetRaw = strOrUndef(p.asset);
  const usdcPriced = p.price_usdc !== undefined && p.price_usdc !== null;
  return {
    url: String(p.url ?? p.endpoint ?? p.resource ?? ''),
    capability: String(p.capability ?? p.service_name ?? capability),
    price: strOrUndef(p.price ?? p.price_usdc),
    asset: findAsset(assetRaw, chain)?.symbol ?? assetRaw ?? (usdcPriced ? 'usdc' : undefined),
    chain: chain?.network ?? strOrUndef(p.chain ?? p.network),
    payTo: strOrUndef(p.payTo ?? p.pay_to),
    successRate: numOrUndef(p.successRate ?? p.success_rate),
    latencyMsP50: numOrUndef(p.latencyMsP50 ?? p.latency_ms_p50),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : strOrUndef(p.updated_at),
    live: typeof p.is_live === 'boolean' ? p.is_live : undefined,
    calls30d: numOrUndef(p.l30_total_calls ?? p.calls30d),
    payers30d: numOrUndef(p.l30_unique_payers ?? p.payers30d),
    lastCalledAt: strOrUndef(p.last_called_at ?? p.lastCalledAt),
    confidence: strOrUndef(p.confidence),
    gateway: typeof p.gateway === 'boolean' ? p.gateway : undefined,
    source: 'index',
  };
};

const providersFrom = (body: unknown, capability: string): Provider[] => {
  const items = Array.isArray(body)
    ? body
    : isObj(body) && Array.isArray(body.offers)
      ? body.offers
      : isObj(body) && Array.isArray(body.endpoints)
        ? body.endpoints
        : isObj(body) && Array.isArray(body.providers)
          ? body.providers
          : isObj(body) && Array.isArray(body.results)
            ? body.results
            : [];
  return items
    .filter(isObj)
    .map((p) => mapProvider(p, capability))
    .filter((p) => p.url !== '')
    .sort(byLivenessThenPrice);
};

/**
 * Pull the market figures out of a capability document.
 *
 * Two shapes, because the API moved the block and changed its case: the current
 * `/v0/unified/<slug>` puts pricing at the top level with `spot_basis`, while
 * the retired `unified.json` nested it under `stats.price` with `spotBasis`.
 * Read both — a caller pointing `discover.unifiedUrl` at the old surface should
 * still get stats rather than a silently empty market.
 */
const statsFrom = (body: unknown): MarketStats | undefined => {
  if (!isObj(body)) return undefined;
  const s = isObj(body.stats) ? body.stats : {};
  const price = isObj(body.price) ? body.price : isObj(s.price) ? s.price : undefined;
  if (!price && Object.keys(s).length === 0) return undefined;
  const p = price ?? {};
  return {
    min: strOrUndef(p.min),
    p25: strOrUndef(p.p25),
    median: strOrUndef(p.median),
    p75: strOrUndef(p.p75),
    max: strOrUndef(p.max),
    spread: numOrUndef(p.spread),
    spot: strOrUndef(p.spot),
    spotBasis: strOrUndef(p.spot_basis ?? p.spotBasis),
    offers: numOrUndef(s.offers),
    priced: numOrUndef(p.priced_offers ?? p.priced),
    unpriced: numOrUndef(p.unpriced_offers ?? p.unpriced),
    providers: numOrUndef(s.providers),
    live: numOrUndef(s.live),
  };
};

/**
 * The capability document's URL.
 *
 * The current API takes the slug as a path segment (`/v0/unified/web-search`).
 * The retired single-document surface took it as a query parameter, and is
 * recognised by its `.json` suffix so that a config still pointing there keeps
 * working rather than requesting `unified.json/web-search` and getting a 404.
 */
function unifiedUrlFor(base: string, capability: string): string {
  const slug = encodeURIComponent(capability);
  return /\.json$/i.test(base)
    ? `${base}?capability=${slug}`
    : `${base.replace(/\/+$/, '')}/${slug}`;
}

/**
 * How many keyword hits to pull when falling back to `/endpoints`.
 *
 * The API defaults to 100 and the results are relevance-ranked, so the tail is
 * mostly noise — but the caller filters by allowlist and liveness afterwards,
 * so cutting too close leaves nothing to choose from.
 */
const ENDPOINT_SEARCH_LIMIT = 50;

/**
 * Resolve a capability to its offers and market stats.
 *
 * The capability document is asked first because it is the only surface that
 * carries capability-wide pricing. It only knows registered slugs and answers
 * 404 for anything else, so an unknown one falls back to the `/endpoints`
 * keyword search, which returns offers but no stats.
 */
export async function discoverMarket(
  capability: string,
  config: X402Config,
  timeoutMs = 10_000,
): Promise<Market> {
  const unified = unifiedUrlFor(config.discover.unifiedUrl, capability);
  const res = await request({
    url: unified,
    method: 'GET',
    headers: { accept: 'application/json', ...authHeaders(unified, config) },
    timeoutMs,
  });
  const body = res.status < 400 ? parseJsonBody(res.body) : undefined;
  const known = isObj(body) && Array.isArray(body.offers);
  if (known) {
    const cap = isObj(body.capability) ? body.capability : {};
    const providers = providersFrom(body, capability);
    const stats = statsFrom(body);
    return {
      capability: strOrUndef(cap.slug) ?? capability,
      name: strOrUndef(cap.name),
      summary: strOrUndef(cap.summary),
      unit: strOrUndef(cap.unit),
      providers,
      stats,
      // Not just the document's own flag: `/v0/unified/web-search` returns 50
      // offers with `stats.offers: 137` and `truncated: false`, so trusting the
      // flag alone would present a capped list as the whole market. Count the
      // offers actually in hand against the count the stats describe.
      truncated:
        body.truncated === true || (stats?.offers !== undefined && providers.length < stats.offers),
      from: 'unified',
    };
  }

  const base = config.discover.indexUrl.replace(/\/+$/, '');
  const url =
    `${base}/endpoints?q=${encodeURIComponent(capability)}` +
    `&limit=${String(ENDPOINT_SEARCH_LIMIT)}`;
  const fallback = await request({
    url,
    method: 'GET',
    headers: { accept: 'application/json', ...authHeaders(url, config) },
    timeoutMs,
  });
  if (fallback.status >= 400) {
    throw new X402Error(ExitCode.GENERIC, `index query failed (HTTP ${fallback.status}) at ${url}`);
  }
  const providers = providersFrom(parseJsonBody(fallback.body), capability);
  return {
    capability,
    providers,
    // A full page back means the search hit its cap, so there may be more.
    truncated: providers.length >= ENDPOINT_SEARCH_LIMIT,
    from: 'endpoints',
  };
}

/** Query the Roundhouse index for providers of a capability, cheapest first. */
export async function discover(
  capability: string,
  config: X402Config,
  timeoutMs = 10_000,
): Promise<Provider[]> {
  return (await discoverMarket(capability, config, timeoutMs)).providers;
}

export function filterByAllowlist(providers: Provider[], config: X402Config): Provider[] {
  const { domains, payTo } = config.allowlist;
  const allowedPayTo = payTo.map((a) => a.toLowerCase());
  return providers.filter((p) => {
    let host: string;
    try {
      host = new URL(p.url).hostname;
    } catch {
      return false;
    }
    if (!domainAllowed(host, domains)) return false;
    if (allowedPayTo.length > 0 && p.payTo && !allowedPayTo.includes(p.payTo.toLowerCase()))
      return false;
    return true;
  });
}

export interface Resolution {
  url: string;
  capability?: string;
  provider?: Provider;
  candidates?: Provider[];
}

/**
 * Resolve a call target. A `x402:<capability>` URI is resolved through config
 * pins first (determinism), then the index (cheapest allowed provider).
 */
export async function resolveTarget(target: string, config: X402Config): Promise<Resolution> {
  const capability = capabilityOf(target);
  if (!capability) return { url: target };

  const pinned = config.pins[capability];
  if (pinned) {
    return {
      url: pinned,
      capability,
      provider: { url: pinned, capability, source: 'pin' },
    };
  }

  const candidates = filterByAllowlist(await discover(capability, config), config);
  // Never auto-route a payment to an endpoint the index last saw down.
  const chosen = candidates.find((p) => p.live !== false);
  if (!chosen) {
    const down = candidates.length > 0 ? `; ${candidates.length} allowed provider(s) are down` : '';
    throw new X402Error(
      ExitCode.GENERIC,
      `no allowed provider for capability "${capability}" in the index (${config.discover.indexUrl})${down}`,
    );
  }
  return { url: chosen.url, capability, provider: chosen, candidates };
}

/** The default ceiling on price, as a multiple of the going rate. */
export const DEFAULT_SPOT_FACTOR = 1.5;

export interface PolicyRejection {
  provider: Provider;
  /** Every rule the offer failed, not only the first. */
  reasons: string[];
}

export interface PolicyResult {
  accepted: Provider[];
  rejected: PolicyRejection[];
  /** The going rate the price rule was judged against, when the market has one. */
  spot: string | null;
  factor: number;
  /** `skipped` when the market reported no spot to judge a price against. */
  priceRule: 'applied' | 'skipped';
}

/**
 * The default counterparty rule, applied to a discovered market.
 *
 * An offer passes only if it is live, has had at least one paying customer in
 * the last 30 days, and is priced at or under `spot` times `factor`. Each rule
 * is judged on evidence the index holds: an offer whose liveness or payer count
 * is simply unknown fails, because "no evidence anyone has paid this" is the
 * thing the rule exists to catch. The price rule is the one that can be skipped,
 * and only when there is no spot to compare to; the result says so rather than
 * quietly passing everything.
 */
export function applyCounterpartyPolicy(
  providers: Provider[],
  stats: MarketStats | undefined,
  factor: number = DEFAULT_SPOT_FACTOR,
): PolicyResult {
  const spot =
    stats?.spot !== undefined && Number.isFinite(Number(stats.spot))
      ? Number(stats.spot)
      : undefined;
  const ceiling = spot === undefined ? undefined : spot * factor;
  const accepted: Provider[] = [];
  const rejected: PolicyRejection[] = [];

  for (const provider of providers) {
    const reasons: string[] = [];
    if (provider.live === false) reasons.push('not live at the last probe');
    else if (provider.live === undefined) reasons.push('liveness unknown');
    if (provider.payers30d === undefined) reasons.push('no payer count from the index');
    else if (provider.payers30d <= 0) reasons.push('no paying customers in the last 30 days');
    if (ceiling !== undefined) {
      const price = Number(provider.price);
      if (provider.price === undefined || !Number.isFinite(price)) {
        reasons.push('no listed price to compare with the going rate');
      } else if (price > ceiling) {
        reasons.push(
          `price ${provider.price} is above ${factor}x the going rate of ${stats?.spot}`,
        );
      }
    }
    if (reasons.length === 0) accepted.push(provider);
    else rejected.push({ provider, reasons });
  }

  return {
    accepted,
    rejected,
    spot: spot === undefined ? null : String(stats?.spot),
    factor,
    priceRule: ceiling === undefined ? 'skipped' : 'applied',
  };
}
