import { X402Error, ExitCode } from './errors.js';
import { request, parseJsonBody } from './http.js';
import { domainAllowed } from './gates.js';
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
  source: 'index' | 'pin';
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const priceOf = (p: Provider): number => {
  const n = Number(p.price);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
};

/** `x402:lei` -> `lei`. Returns undefined for ordinary URLs. */
export function capabilityOf(target: string): string | undefined {
  const m = /^x402:(?:\/\/)?([A-Za-z0-9._-]+)$/.exec(target.trim());
  return m ? m[1] : undefined;
}

/** Query the IOI index for providers of a capability, cheapest first. */
export async function discover(
  capability: string,
  config: X402Config,
  timeoutMs = 10_000,
): Promise<Provider[]> {
  const base = config.discover.indexUrl.replace(/\/+$/, '');
  const url = `${base}/discover?capability=${encodeURIComponent(capability)}`;
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
    : isObj(body) && Array.isArray(body.providers)
      ? body.providers
      : isObj(body) && Array.isArray(body.results)
        ? body.results
        : [];

  return items
    .filter(isObj)
    .map((p): Provider => ({
      url: String(p.url ?? p.endpoint ?? ''),
      capability: String(p.capability ?? capability),
      price: p.price === undefined ? undefined : String(p.price),
      asset: p.asset === undefined ? undefined : String(p.asset),
      chain: p.chain === undefined ? undefined : String(p.chain),
      payTo: p.payTo === undefined ? undefined : String(p.payTo),
      successRate: typeof p.successRate === 'number' ? p.successRate : undefined,
      latencyMsP50: typeof p.latencyMsP50 === 'number' ? p.latencyMsP50 : undefined,
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
      source: 'index',
    }))
    .filter((p) => p.url !== '')
    .sort((a, b) => priceOf(a) - priceOf(b));
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
  const chosen = candidates[0];
  if (!chosen) {
    throw new X402Error(
      ExitCode.GENERIC,
      `no allowed provider for capability "${capability}" in the index (${config.discover.indexUrl})`,
    );
  }
  return { url: chosen.url, capability, provider: chosen, candidates };
}
