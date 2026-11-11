import { formatUnits } from './assets.js';
import type { SettlementResponse } from './eip3009.js';
import type { PaymentOption } from './x402.js';

/**
 * Reading what a provider actually settled, as opposed to what was signed.
 *
 * An `upto` payment signs a ceiling and the provider settles what the work
 * cost, so the amount that left the wallet is usually lower than the amount the
 * gates were checked against. The ledger and the daily cap should count what
 * left the wallet. They must never count less than that, so every function here
 * answers "unknown" rather than guessing low.
 */

/**
 * The smallest USDC payment some facilitators accept: 0.001 USDC. A provider
 * that quotes less will see its payments rejected with `amount_too_low`.
 */
export const FACILITATOR_MIN_ATOMIC = 1000n;

export const AMOUNT_TOO_LOW_HINT =
  'The facilitator minimum is 0.001 USDC (1000 atomic units). Raise the request size ' +
  '(for example max_tokens) so the quote reaches it, or use a provider that quotes at least that.';

/**
 * The amount a settlement receipt says was moved, in atomic units, or undefined
 * when it says nothing usable. A figure above what was signed is not believed:
 * it cannot be what the signature allowed, so the caller falls back to the
 * signed amount rather than trusting a number that is wrong in an unknown way.
 */
export function settledAtomic(
  settlement: SettlementResponse | undefined,
  signedAtomic: bigint,
): bigint | undefined {
  if (settlement?.success !== true) return undefined;
  const raw = settlement.amount;
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return undefined;
  const value = BigInt(text);
  return value > signedAtomic ? undefined : value;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The settlement an SSE response carries in its last `x402_settlement` frame.
 *
 * A streamed response has already sent its headers when the provider settles,
 * so the receipt arrives as a final `data:` line:
 * `{"x402_settlement":{"ok":true,"transaction":"0x…","payer":"0x…","amount":"3939"}}`.
 * The last such frame wins. A frame that is not valid JSON is skipped.
 */
export function settlementFromStream(body: string): SettlementResponse | undefined {
  if (!body.includes('x402_settlement')) return undefined;
  let found: SettlementResponse | undefined;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const text = trimmed.slice(5).trim();
    if (!text.includes('x402_settlement')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const frame = isObj(parsed) ? parsed.x402_settlement : undefined;
    if (!isObj(frame)) continue;
    const ok = frame.ok === true;
    const settlement: SettlementResponse = { success: ok };
    if (typeof frame.transaction === 'string') settlement.transaction = frame.transaction;
    if (typeof frame.network === 'string') settlement.network = frame.network;
    if (typeof frame.payer === 'string') settlement.payer = frame.payer;
    if (typeof frame.amount === 'string' || typeof frame.amount === 'number') {
      settlement.amount = String(frame.amount);
    }
    if (!ok && typeof frame.message === 'string') settlement.errorReason = frame.message;
    found = settlement;
  }
  return found;
}

/**
 * A provider that ran the request and then could not settle the payment answers
 * 5xx with an OpenAI-shaped error whose code is `settlement_failed`. The
 * authorization was not captured: nothing was paid and no response comes with
 * it. Returns the provider's own message, or undefined for any other response.
 */
export function settlementFailure(status: number, body: string): string | undefined {
  if (status < 500) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error = isObj(parsed) ? parsed.error : undefined;
  if (!isObj(error) || error.code !== 'settlement_failed') return undefined;
  return typeof error.message === 'string' && error.message !== ''
    ? error.message
    : 'the provider could not settle the payment';
}

/** True when any text says the facilitator refused the amount as too small. */
export function isAmountTooLow(text: string): boolean {
  return /amount[_ ]too[_ ]low/i.test(text);
}

/** A quote the facilitator would reject for being too small. USDC only: the minimum is in USDC. */
export function belowFacilitatorMinimum(option: PaymentOption): boolean {
  return (
    option.assetSymbol.toUpperCase() === 'USDC' &&
    option.amountAtomic > 0n &&
    option.amountAtomic < FACILITATOR_MIN_ATOMIC
  );
}

/** Warnings about a quote worth showing before anything is signed. */
export function quoteWarnings(option: PaymentOption): string[] {
  if (!belowFacilitatorMinimum(option)) return [];
  return [
    `The quote of ${option.amount} ${option.assetSymbol} (${option.amountAtomic.toString()} atomic units) is ` +
      'below the 0.001 USDC (1000 atomic units) minimum some facilitators accept, so this payment may be ' +
      'rejected with amount_too_low. ' +
      AMOUNT_TOO_LOW_HINT,
  ];
}

/** `0.003939` from 3939n at 6 decimals. */
export function formatSettled(atomic: bigint, decimals: number): string {
  return formatUnits(atomic, decimals);
}
