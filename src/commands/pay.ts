import { readFileSync, writeFileSync } from 'node:fs';
import { X402Error, ExitCode } from '../core/errors.js';
import {
  assertSupportedVersion,
  decodeQuote,
  parsePaymentRequired,
  selectOption,
} from '../core/x402.js';
import {
  buildAuthorization,
  buildPaymentPayload,
  encodePaymentHeader,
  paymentHeaderName,
} from '../core/eip3009.js';
import { runGates } from '../core/gates.js';
import { writeJson, isTty } from '../core/output.js';
import { str, type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';
import { readStdin } from '../core/stdin.js';
import { tagged, ulid } from '../core/ids.js';

/**
 * Build a signed payment header from a 402 payload. No HTTP is performed, and
 * the authorization cache is not used: without a request identity there is
 * nothing to key it on.
 *
 * The header name follows the quote: `X-PAYMENT` for x402 v1, `PAYMENT-SIGNATURE`
 * for v2. The payload may be JSON, a base64 `PAYMENT-REQUIRED` value, or a whole
 * header line — `probe` reports the base64 form, so that is what an agent has.
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
      'usage: rh-x402 pay <402-json|base64|@file|-> ' +
        '(reads the 402 body, or a PAYMENT-REQUIRED header value, from argv, a file, or stdin)',
    );
  }

  const requirements = parsePaymentRequired(decodeQuote(raw));
  // Refuse a version this build cannot address before anything is signed.
  assertSupportedVersion(requirements.x402Version);
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
  const payload = buildPaymentPayload(option, built.typedData, signature, {
    x402Version: requirements.x402Version,
    resource: requirements.resource,
    extensions: requirements.extensions,
  });
  const header = encodePaymentHeader(payload);
  // `x-payment` for v1, `payment-signature` for v2. Printed in the canonical
  // upper case a header line uses.
  const headerName = paymentHeaderName(requirements.x402Version).toUpperCase();

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
    x402Version: requirements.x402Version,
    headerName,
    state: 'signed' as const,
  };

  const receiptOut = str(parsed.flags, 'receipt-out');
  if (receiptOut) {
    writeFileSync(receiptOut, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  }

  if (isTty()) {
    process.stdout.write(`${headerName}: ${header}\n`);
    process.stdout.write(
      `${option.amount} ${option.assetSymbol} to ${option.payTo} on ${option.network}, valid until ${new Date(
        built.validBefore * 1000,
      ).toISOString()}\n`,
    );
  } else {
    writeJson({ ok: true, headerName, header, payload, receipt });
  }
  return ExitCode.OK;
}
