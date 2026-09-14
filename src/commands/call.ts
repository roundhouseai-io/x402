import { readFileSync, writeFileSync } from 'node:fs';
import { X402Error, ExitCode } from '../core/errors.js';
import { decodeQuote, parsePaymentRequired } from '../core/x402.js';
import { buildData } from '../core/data.js';
import { emitCallResult, writeJson, isTty } from '../core/output.js';
import { bool, str, list, parseHeaders, type ParsedArgs } from '../core/args.js';
import { buildContext, callOptionsFrom } from './context.js';
import { readStdin } from '../core/stdin.js';

/** A target that is a saved 402 quote rather than a URL. */
const isQuoteTarget = (target: string): boolean => target === '-' || target.startsWith('@');

/**
 * Resolve a `@file` or `-` target to the URL its 402 quote refers to.
 *
 * `pay` has always taken a saved quote; `call` took only a URL, so an agent
 * holding a quote had to dig the resource URL out of it by hand. The quote is
 * used for its URL only — the payment is made against a *fresh* 402 from that
 * URL, which is what x402 v2 requires anyway ("request a fresh unsigned
 * quote"): a stale price is never signed because an old file said so.
 */
function targetFromQuote(target: string, stdin: string | undefined): string {
  const raw = target === '-' ? stdin : readFileSync(target.slice(1), 'utf8');
  if (!raw || raw.trim() === '') {
    throw new X402Error(
      ExitCode.GENERIC,
      target === '-' ? 'no 402 quote on stdin' : `empty 402 quote: ${target.slice(1)}`,
    );
  }

  const requirements = parsePaymentRequired(decodeQuote(raw));
  const url =
    (typeof requirements.resource?.url === 'string' ? requirements.resource.url : undefined) ??
    requirements.options.find((o) => o.resource !== undefined)?.resource;
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new X402Error(
      ExitCode.GENERIC,
      'the 402 quote names no resource URL to call. Pass the URL directly, ' +
        'or use `rh-x402 pay` to sign the quote into a payment header.',
    );
  }
  return url;
}

export async function callCommand(parsed: ParsedArgs): Promise<number> {
  const target = parsed.positionals[0];
  if (!target)
    throw new X402Error(
      ExitCode.GENERIC,
      'usage: rh-x402 call <url|x402:capability|@402.json|-> [flags]',
    );

  const ctx = buildContext(parsed);
  const quoteTarget = isQuoteTarget(target);
  if (quoteTarget && str(parsed.flags, 'json') === '-') {
    throw new X402Error(
      ExitCode.GENERIC,
      'stdin cannot carry both the 402 quote and --json -; pass the quote as @file',
    );
  }
  const stdin = await readStdin({ force: quoteTarget || str(parsed.flags, 'json') === '-' });
  const url = quoteTarget ? targetFromQuote(target, stdin) : target;
  const { data } = buildData({
    dataFlags: parsed.dataFlags,
    json: str(parsed.flags, 'json'),
    // stdin held the quote, not request data.
    ...(quoteTarget ? {} : { stdin }),
    strings: bool(parsed.flags, 'data-strings'),
  });

  const result = await ctx.engine.call({
    target: url,
    data,
    headers: parseHeaders(list(parsed.flags, 'header')),
    payloadLevel: ctx.payloadLevel,
    wallet: ctx.walletName,
    signer: ctx.backendName,
    ...callOptionsFrom(parsed),
  });

  const receiptOut = str(parsed.flags, 'receipt-out');
  if (receiptOut && result.receipt) {
    writeFileSync(receiptOut, `${JSON.stringify(result.receipt, null, 2)}\n`, { mode: 0o600 });
  }

  emitCallResult(result, {
    raw: bool(parsed.flags, 'raw'),
    out: str(parsed.flags, 'out'),
  });

  await ctx.sink.flush();
  return result.errorCode ?? (result.ok ? ExitCode.OK : ExitCode.GENERIC);
}

export async function probeCommand(parsed: ParsedArgs): Promise<number> {
  const target = parsed.positionals[0];
  if (!target)
    throw new X402Error(ExitCode.GENERIC, 'usage: rh-x402 probe <url|x402:capability|@402.json|->');

  const ctx = buildContext(parsed);
  const quoteTarget = isQuoteTarget(target);
  const stdin = await readStdin({ force: quoteTarget || str(parsed.flags, 'json') === '-' });
  const url = quoteTarget ? targetFromQuote(target, stdin) : target;
  const { data } = buildData({
    dataFlags: parsed.dataFlags,
    json: str(parsed.flags, 'json'),
    ...(quoteTarget ? {} : { stdin }),
    strings: bool(parsed.flags, 'data-strings'),
  });

  const probe = await ctx.engine.probe({
    target: url,
    data,
    headers: parseHeaders(list(parsed.flags, 'header')),
    ...callOptionsFrom(parsed),
  });

  const payload = {
    ok: true,
    url: probe.url,
    status: probe.status,
    paymentRequired: probe.status === 402,
    ...(probe.capability ? { capability: probe.capability, provider: probe.provider?.url } : {}),
    ...(probe.selected
      ? {
          selected: {
            scheme: probe.selected.scheme,
            network: probe.selected.network,
            chain: probe.selected.chain,
            asset: probe.selected.assetSymbol,
            assetAddress: probe.selected.asset,
            amount: probe.selected.amount,
            amountAtomic: probe.selected.amountAtomic.toString(),
            payTo: probe.selected.payTo,
            maxTimeoutSeconds: probe.selected.maxTimeoutSeconds,
            description: probe.selected.description,
          },
        }
      : {}),
    ...(probe.requirements
      ? {
          options: probe.requirements.options.map((o) => ({
            scheme: o.scheme,
            network: o.network,
            asset: o.assetSymbol,
            amount: o.amount,
            payTo: o.payTo,
          })),
          x402Version: probe.requirements.x402Version,
        }
      : {}),
    ...(probe.body !== undefined && probe.status !== 402 ? { body: probe.body } : {}),
  };

  if (isTty() && probe.selected) {
    const o = probe.selected;
    process.stdout.write(
      `${probe.url}\n402 ${o.amount} ${o.assetSymbol} on ${o.network} to ${o.payTo} (scheme ${o.scheme})\n`,
    );
    if (probe.requirements && probe.requirements.options.length > 1) {
      process.stdout.write(`${probe.requirements.options.length} payment options offered\n`);
    }
  } else if (isTty()) {
    process.stdout.write(`${probe.url}\nno payment required (HTTP ${probe.status})\n`);
  } else {
    writeJson(payload);
  }

  await ctx.sink.flush();
  return ExitCode.OK;
}
