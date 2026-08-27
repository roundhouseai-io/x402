import { X402Error, ExitCode } from './errors.js';
import { request, parseJsonBody } from './http.js';
import { domainAllowed } from './gates.js';
import { findChain, findAsset } from './assets.js';
import type { X402Config } from './config.js';

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
  source: 'index' | 'pin';
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

/** Query the Roundhouse index for providers of a capability, cheapest first. */
export async function discover(
  capability: string,
  config: X402Config,
  timeoutMs = 10_000,
): Promise<Provider[]> {
  const base = config.discover.indexUrl.replace(/\/+$/, '');
  const url = `${base}/endpoints?q=${encodeURIComponent(capability)}`;
  const res = await request({
    url,
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs,
  });
  if (res.status >= 400) {
    throw new X402Error(ExitCode.GENERIC, `index query failed (HTTP ${res.status}) at ${url}`);
  }
  const body = parseJsonBody(res.body);
  const items = Array.isArray(body)
    ? body
    : isObj(body) && Array.isArray(body.endpoints)
      ? body.endpoints
      : isObj(body) && Array.isArray(body.providers)
        ? body.providers
        : isObj(body) && Array.isArray(body.results)
          ? body.results
          : [];

  return items
    .filter(isObj)
    .map((p): Provider => {
      // The index states the chain as CAIP-2 (`eip155:8453`) and the asset as a
      // contract address; normalise both through the tables so `defaults.chain`
      // and the allowlists compare against the same names the 402 parser yields.
      const chain = findChain(strOrUndef(p.chain ?? p.network));
      const assetRaw = strOrUndef(p.asset);
      const usdcPriced = p.price_usdc !== undefined && p.price_usdc !== null;
      return {
        url: String(p.url ?? p.endpoint ?? p.resource ?? ''),
        capability: String(p.capability ?? p.service_name ?? capability),
        price: strOrUndef(p.price ?? p.price_usdc),
        asset:
          findAsset(assetRaw, chain?.chainId)?.symbol ??
          assetRaw ??
          (usdcPriced ? 'usdc' : undefined),
        chain: chain?.network ?? strOrUndef(p.chain ?? p.network),
        payTo: strOrUndef(p.payTo ?? p.pay_to),
        successRate: numOrUndef(p.successRate ?? p.success_rate),
        latencyMsP50: numOrUndef(p.latencyMsP50 ?? p.latency_ms_p50),
        updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : strOrUndef(p.updated_at),
        live: typeof p.is_live === 'boolean' ? p.is_live : undefined,
        calls30d: numOrUndef(p.l30_total_calls ?? p.calls30d),
        payers30d: numOrUndef(p.l30_unique_payers ?? p.payers30d),
        source: 'index',
      };
    })
    .filter((p) => p.url !== '')
    .sort(byLivenessThenPrice);
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
