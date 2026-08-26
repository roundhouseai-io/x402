import { writeFileSync } from 'node:fs';
import { X402Error, ExitCode } from '../core/errors.js';
import { buildData } from '../core/data.js';
import { emitCallResult, writeJson, isTty } from '../core/output.js';
import { bool, str, list, parseHeaders, type ParsedArgs } from '../core/args.js';
import { buildContext, callOptionsFrom } from './context.js';
import { readStdin } from '../core/stdin.js';

export async function callCommand(parsed: ParsedArgs): Promise<number> {
  const target = parsed.positionals[0];
  if (!target)
    throw new X402Error(ExitCode.GENERIC, 'usage: x402 call <url|x402:capability> [flags]');

  const ctx = buildContext(parsed);
  const stdin = await readStdin({ force: str(parsed.flags, 'json') === '-' });
  const { data } = buildData({
    dataFlags: parsed.dataFlags,
    json: str(parsed.flags, 'json'),
    stdin,
    strings: bool(parsed.flags, 'data-strings'),
  });

  const result = await ctx.engine.call({
    target,
    data,
    headers: parseHeaders(list(parsed.flags, 'header')),
    payloadLevel: ctx.payloadLevel,
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
  if (!target) throw new X402Error(ExitCode.GENERIC, 'usage: x402 probe <url|x402:capability>');

  const ctx = buildContext(parsed);
  const stdin = await readStdin({ force: str(parsed.flags, 'json') === '-' });
  const { data } = buildData({
    dataFlags: parsed.dataFlags,
    json: str(parsed.flags, 'json'),
    stdin,
    strings: bool(parsed.flags, 'data-strings'),
  });

  const probe = await ctx.engine.probe({
    target,
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
