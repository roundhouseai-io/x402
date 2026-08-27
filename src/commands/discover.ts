import { X402Error, ExitCode } from '../core/errors.js';
import { discover, filterByAllowlist, capabilityOf } from '../core/discover.js';
import { writeJson, isTty } from '../core/output.js';
import { num, str, type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';

/** Query the Roundhouse index for providers of a capability, price-sorted. */
export async function discoverCommand(parsed: ParsedArgs): Promise<number> {
  const ctx = buildContext(parsed);
  const raw = parsed.positionals[0] ?? str(parsed.flags, 'capability');
  if (!raw) throw new X402Error(ExitCode.GENERIC, 'usage: x402 discover <capability>');
  const capability = capabilityOf(raw) ?? raw;

  const all = await discover(capability, ctx.config);
  const allowed = filterByAllowlist(all, ctx.config);
  const limit = num(parsed.flags, 'limit');
  const providers = limit ? allowed.slice(0, limit) : allowed;
  const pinned = ctx.config.pins[capability];

  if (isTty()) {
    if (pinned) process.stdout.write(`pinned: ${pinned}\n`);
    if (providers.length === 0) process.stdout.write(`no providers for ${capability}\n`);
    for (const p of providers) {
      const price = p.price ?? '?';
      const rate = p.successRate === undefined ? '' : ` ${(p.successRate * 100).toFixed(0)}% ok`;
      const down = p.live === false ? ' [down]' : '';
      process.stdout.write(`${price.padStart(10)} ${p.asset ?? ''}  ${p.url}${rate}${down}\n`);
    }
    if (allowed.length !== all.length) {
      process.stdout.write(`${all.length - allowed.length} provider(s) hidden by allowlist\n`);
    }
  } else {
    writeJson({
      ok: true,
      capability,
      pinned: pinned ?? null,
      count: providers.length,
      filteredByAllowlist: all.length - allowed.length,
      providers,
    });
  }
  return ExitCode.OK;
}
