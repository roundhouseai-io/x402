import { X402Error, ExitCode } from '../core/errors.js';
import {
  discoverMarket,
  filterByAllowlist,
  capabilityOf,
  applyCounterpartyPolicy,
  DEFAULT_SPOT_FACTOR,
} from '../core/discover.js';
import { writeJson, isTty } from '../core/output.js';
import { bool, num, str, type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';

/** Query the Roundhouse index for providers of a capability, price-sorted. */
export async function discoverCommand(parsed: ParsedArgs): Promise<number> {
  const ctx = buildContext(parsed);
  const raw = parsed.positionals[0] ?? str(parsed.flags, 'capability');
  if (!raw) throw new X402Error(ExitCode.GENERIC, 'usage: rh-x402 discover <capability>');
  const capability = capabilityOf(raw) ?? raw;

  const market = await discoverMarket(capability, ctx.config);
  const all = market.providers;
  const allowed = filterByAllowlist(all, ctx.config);
  const limit = num(parsed.flags, 'limit');

  // `--policy` splits the allowed offers into those a default buyer would pay
  // and those it would not, and says why for each. Nothing is dropped silently.
  const factorText = str(parsed.flags, 'spot-factor');
  const factor = factorText === undefined ? DEFAULT_SPOT_FACTOR : Number(factorText);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new X402Error(
      ExitCode.GENERIC,
      `--spot-factor must be a positive number, got ${factorText}`,
    );
  }
  const policy = bool(parsed.flags, 'policy')
    ? applyCounterpartyPolicy(allowed, market.stats, factor)
    : undefined;
  const passing = policy ? policy.accepted : allowed;
  const providers = limit ? passing.slice(0, limit) : passing;
  const pinned = ctx.config.pins[capability];

  const { stats } = market;
  if (isTty()) {
    if (pinned) process.stdout.write(`pinned: ${pinned}\n`);
    if (stats) {
      const unit = market.unit ? ` ${market.unit}` : '';
      process.stdout.write(
        `min ${stats.min} · median ${stats.median} · spot ${stats.spot} · max ${stats.max}` +
          `${unit} (${stats.spread}x spread over ${stats.offers} offers)\n`,
      );
    }
    if (providers.length === 0) process.stdout.write(`no providers for ${capability}\n`);
    if (market.truncated) {
      // Said before the list, not after: "cheapest first" over a capped list is
      // cheapest of what came back, and the stats line above describes more.
      process.stdout.write(`showing part of the offer list — the index capped it\n`);
    }
    for (const p of providers) {
      const price = p.price ?? '?';
      const rate = p.successRate === undefined ? '' : ` ${(p.successRate * 100).toFixed(0)}% ok`;
      const down = p.live === false ? ' [down]' : '';
      process.stdout.write(`${price.padStart(10)} ${p.asset ?? ''}  ${p.url}${rate}${down}\n`);
    }
    if (allowed.length !== all.length) {
      process.stdout.write(`${all.length - allowed.length} provider(s) hidden by allowlist\n`);
    }
    if (policy) {
      if (policy.priceRule === 'skipped') {
        process.stdout.write('price rule skipped: the index reported no going rate\n');
      }
      if (policy.rejected.length > 0) {
        process.stdout.write(`\nexcluded by --policy (${policy.rejected.length}):\n`);
        for (const r of policy.rejected) {
          process.stdout.write(`  ${r.provider.url}\n    ${r.reasons.join('; ')}\n`);
        }
      }
    }
  } else {
    writeJson({
      ok: true,
      capability,
      name: market.name ?? null,
      unit: market.unit ?? null,
      pinned: pinned ?? null,
      count: providers.length,
      filteredByAllowlist: all.length - allowed.length,
      // Capability-wide pricing, so a caller can judge an offer against the market.
      stats: stats ?? null,
      // The index capped the offer list, so `providers` is not the whole market
      // and the cheapest here is not necessarily the cheapest that exists.
      truncated: market.truncated ?? false,
      indexSurface: market.from,
      ...(policy
        ? {
            policy: {
              applied: true,
              rules: {
                live: true,
                minPayers30d: 1,
                maxPriceVsSpot: policy.factor,
              },
              spot: policy.spot,
              priceRule: policy.priceRule,
              rejected: policy.rejected.map((r) => ({ ...r.provider, reasons: r.reasons })),
            },
          }
        : {}),
      providers,
    });
  }
  return ExitCode.OK;
}
