import { existsSync, readFileSync } from 'node:fs';
import { X402Error, ExitCode } from '../core/errors.js';
import { readRecords } from '../core/ledger.js';
import { request, parseJsonBody } from '../core/http.js';
import { writeJson, isTty } from '../core/output.js';
import { type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';
import { readStdin } from '../core/stdin.js';

interface ReceiptLike {
  id?: string;
  amount?: string;
  assetSymbol?: string;
  payTo?: string;
  chain?: string;
  network?: string;
  nonce?: string;
  validBefore?: number;
  settlement?: { success?: boolean; transaction?: string; errorReason?: string } | undefined;
  status?: number | null;
}

/**
 * Confirm settlement of a prior payment.
 *
 * v1 asks the configured facilitator. With no facilitator configured, the
 * recorded settlement from the paid response is reported as-is and flagged
 * untrusted — an on-chain check lands in v1.1 (spec open question 3).
 */
export async function verifyCommand(parsed: ParsedArgs): Promise<number> {
  const ctx = buildContext(parsed);
  const arg = parsed.positionals[0];
  const receipt = await loadReceipt(arg);

  const tx = receipt.settlement?.transaction;
  const facilitator = ctx.config.facilitator.url;

  let verified = false;
  let source: 'facilitator' | 'receipt' | 'none' = 'none';
  let detail: unknown;

  if (facilitator && tx) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (ctx.config.facilitator.token)
      headers.authorization = `Bearer ${ctx.config.facilitator.token}`;
    const res = await request({
      url: `${facilitator.replace(/\/+$/, '')}/settlement/${encodeURIComponent(tx)}`,
      method: 'GET',
      headers,
      timeoutMs: 15_000,
    });
    detail = parseJsonBody(res.body) ?? res.body;
    verified =
      res.status < 400 &&
      (detail as { success?: boolean; settled?: boolean } | undefined)?.success !== false;
    source = 'facilitator';
  } else if (receipt.settlement) {
    verified = receipt.settlement.success === true;
    source = 'receipt';
    detail = receipt.settlement;
  }

  const payload = {
    ok: verified,
    verified,
    source,
    trusted: source === 'facilitator',
    receiptId: receipt.id,
    transaction: tx,
    amount: receipt.amount,
    asset: receipt.assetSymbol,
    payTo: receipt.payTo,
    chain: receipt.chain,
    detail,
    ...(source === 'none'
      ? {
          error:
            'no settlement information available: the provider returned no X-PAYMENT-RESPONSE and no facilitator is configured',
        }
      : {}),
  };

  if (isTty()) {
    process.stdout.write(
      `${verified ? 'settled' : 'unconfirmed'}  ${receipt.amount ?? '?'} ${receipt.assetSymbol ?? ''} -> ${
        receipt.payTo ?? '?'
      }\nsource ${source}${tx ? `  tx ${tx}` : ''}\n`,
    );
  } else {
    writeJson(payload);
  }

  return verified ? ExitCode.OK : ExitCode.GENERIC;
}

async function loadReceipt(arg: string | undefined): Promise<ReceiptLike> {
  const stdin = arg === undefined || arg === '-' ? await readStdin({ force: true }) : undefined;
  const raw = arg && arg !== '-' ? arg : stdin;
  if (!raw || raw.trim() === '') {
    throw new X402Error(ExitCode.GENERIC, 'usage: rh-x402 verify <receiptId|@file|-|json>');
  }

  const text = raw.trim();
  if (text.startsWith('@')) return JSON.parse(readFileSync(text.slice(1), 'utf8')) as ReceiptLike;
  if (text.startsWith('{')) return JSON.parse(text) as ReceiptLike;
  if (existsSync(text)) return JSON.parse(readFileSync(text, 'utf8')) as ReceiptLike;

  // Otherwise treat it as a ledger record id.
  const record = readRecords().find((r) => r.id === text);
  if (!record) throw new X402Error(ExitCode.GENERIC, `no ledger record with id ${text}`);
  return {
    id: record.id,
    amount: record.payment.amount,
    assetSymbol: record.payment.asset,
    payTo: record.payment.payTo,
    chain: record.payment.chain,
    settlement: record.payment.settlement as ReceiptLike['settlement'],
    status: record.response.status,
  };
}
