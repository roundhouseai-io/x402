import { readFileSync, writeFileSync } from 'node:fs';
import { X402Error, ExitCode } from '../core/errors.js';
import { parsePaymentRequired, selectOption } from '../core/x402.js';
import { buildAuthorization, buildPaymentPayload, encodePaymentHeader } from '../core/eip3009.js';
import { runGates } from '../core/gates.js';
import { writeJson, isTty } from '../core/output.js';
import { str, type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';
import { readStdin } from '../core/stdin.js';
import { tagged, ulid } from '../core/ids.js';

/**
 * Build a signed `X-PAYMENT` header from a 402 payload. No HTTP is performed,
 * and the authorization cache is not used: without a request identity there is
 * nothing to key it on.
 */
export async function payCommand(parsed: ParsedArgs): Promise<number> {
  const ctx = buildContext(parsed);
  const arg = parsed.positionals[0];
  const stdin = await readStdin({ force: arg === undefined || arg === '-' });

  let raw: string | undefined;
  if (arg === undefined || arg === '-') raw = stdin;
  else if (arg.startsWith('@')) raw = readFileSync(arg.slice(1), 'utf8');
  else raw = arg;

  if (!raw || raw.trim() === '') {
    throw new X402Error(
      ExitCode.GENERIC,
      'usage: rh-x402 pay <402-json|@file|-> (reads the 402 body from argv, a file, or stdin)',
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch (err) {
    throw new X402Error(ExitCode.INVALID_402, `not JSON: ${(err as Error).message}`);
  }

  const requirements = parsePaymentRequired(parsedBody);
  const option = selectOption(requirements, {
    chains: str(parsed.flags, 'chain')
      ? [str(parsed.flags, 'chain')!]
      : [ctx.config.defaults.chain],
    preferChain: ctx.config.defaults.chain,
  });

  runGates({
    option,
    url: option.resource ?? 'about:blank',
    allowPayTo: ctx.config.allowlist.payTo,
    // A bare 402 payload carries no request URL, so the domain gate cannot apply.
    allowDomains: option.resource ? ctx.config.allowlist.domains : [],
    maxPerCall: str(parsed.flags, 'max') ?? ctx.config.limits.maxPerCall,
  });

  const signer = await ctx.signer();
  const from = await signer.getAddress();
  const built = buildAuthorization({ option, from });
  const signature = await signer.signTypedData(built.typedData);
  const payload = buildPaymentPayload(option, built.typedData, signature);
  const header = encodePaymentHeader(payload);

  const receipt = {
    id: ulid(),
    ts: new Date().toISOString(),
    wallet: signer.wallet,
    backend: signer.backend,
    from,
    payTo: option.payTo,
    amount: option.amount,
    amountAtomic: option.amountAtomic.toString(),
    asset: option.asset,
    assetSymbol: option.assetSymbol,
    chain: option.chain,
    network: option.network,
    scheme: option.scheme,
    nonce: built.nonce,
    validBefore: built.validBefore,
    authHash: tagged(signature),
  };

  const receiptOut = str(parsed.flags, 'receipt-out');
  if (receiptOut) {
    writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  }

  if (isTty()) {
    process.stdout.write(`X-PAYMENT: ${header}\n`);
    process.stdout.write(
      `${option.amount} ${option.assetSymbol} to ${option.payTo} on ${option.network}, valid until ${new Date(
        built.validBefore * 1000,
      ).toISOString()}\n`,
    );
  } else {
    writeJson({ ok: true, header, payload, receipt });
  }
  return ExitCode.OK;
}
