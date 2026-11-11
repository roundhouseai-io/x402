import { writeFileSync } from 'node:fs';
import { ExitCodeName } from './errors.js';
import { isRedactedHeader } from './telemetry.js';
import type { CallResult, PaymentState } from './engine.js';

export const isTty = (): boolean => process.stdout.isTTY === true;

export interface Envelope {
  ok: boolean;
  status: number | null;
  /** True once the authorization was submitted and not rejected. */
  paid: boolean;
  /** none | signed | submitted | settled. The detail behind `paid`. */
  paymentState: PaymentState;
  amount: string;
  /** The signed ceiling, when the provider settled less than it. */
  ceiling?: string;
  /** Things worth knowing before paying, such as a quote under the facilitator minimum. */
  warnings?: string[];
  asset?: string;
  receiptId: string;
  url?: string;
  capability?: string;
  provider?: string;
  cacheHit?: boolean;
  dryRun?: boolean;
  /** The provider's own `x-*` response headers. Auth-like ones are never included. */
  response?: { headers: Record<string, string> };
  body?: unknown;
  errorCode?: number;
  error?: string;
  errorName?: string;
}

/** The agent-facing contract: one JSON object per call, on stdout. */
export function toEnvelope(result: CallResult): Envelope {
  const env: Envelope = {
    ok: result.ok,
    status: result.status,
    paid: result.paid,
    paymentState: result.paymentState,
    amount: result.amount,
    receiptId: result.receiptId,
  };
  if (result.asset) env.asset = result.asset;
  if (result.url) env.url = result.url;
  if (result.capability) env.capability = result.capability;
  if (result.provider) env.provider = result.provider.url;
  if (result.cacheHit !== undefined) env.cacheHit = result.cacheHit;
  if (result.dryRun) env.dryRun = true;
  if (result.ceiling) env.ceiling = result.ceiling;
  if (result.warnings && result.warnings.length > 0) env.warnings = result.warnings;
  const headers = publicResponseHeaders(result.headers);
  if (Object.keys(headers).length > 0) env.response = { headers };
  if (result.body !== undefined) env.body = result.body;
  if (result.errorCode !== undefined) {
    env.errorCode = result.errorCode;
    env.errorName = ExitCodeName[result.errorCode] ?? 'error';
  }
  if (result.error) env.error = result.error;
  return env;
}

/**
 * The provider's `x-*` response headers, for the envelope: what it charged, which
 * venue served the call, the settlement transaction. The names that carry
 * credentials or payment instruments are never included, at any level, and
 * neither is anything whose name says it is a secret. Invariant 4.
 */
const SECRET_NAME = /(token|secret|key|auth|cookie|session|password|signature)/i;

export function publicResponseHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (!lower.startsWith('x-')) continue;
    if (isRedactedHeader(lower) || SECRET_NAME.test(lower)) continue;
    out[lower] = value;
  }
  return out;
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, jsonSafe, 2)}\n`);
}

export function writeCompactJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, jsonSafe)}\n`);
}

/** BigInt is unavoidable in payment amounts; serialize it as a decimal string. */
function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function writeErr(message: string): void {
  process.stderr.write(`x402: ${message}\n`);
}

export interface EmitOptions {
  raw?: boolean;
  out?: string | undefined;
  tty?: boolean;
}

/** Emit a call result: human summary on a TTY, JSON envelope otherwise. */
export function emitCallResult(result: CallResult, opts: EmitOptions = {}): void {
  const tty = opts.tty ?? isTty();
  const bodyText =
    result.rawBody ??
    (result.body === undefined
      ? ''
      : typeof result.body === 'string'
        ? result.body
        : JSON.stringify(result.body, jsonSafe, 2));

  if (opts.out) {
    writeFileSync(opts.out, bodyText.endsWith('\n') ? bodyText : `${bodyText}\n`);
  }

  if (opts.raw) {
    if (!opts.out) process.stdout.write(bodyText.endsWith('\n') ? bodyText : `${bodyText}\n`);
    if (result.error) writeErr(result.error);
    return;
  }

  if (!tty) {
    const env = toEnvelope(result);
    if (opts.out) delete env.body;
    writeJson(env);
    return;
  }

  // Human form.
  const paid = result.paid
    ? `paid ${result.amount} ${result.asset ?? ''}`.trim() +
      (result.paymentState === 'settled' ? ' (settled)' : '')
    : result.paymentState === 'signed'
      ? 'signed, not paid'
      : 'free';
  const cache = result.cacheHit ? ' (cached authorization)' : '';
  const head = result.ok ? 'ok' : `failed (${ExitCodeName[result.errorCode ?? 1] ?? 'error'})`;
  process.stdout.write(`${head}  ${result.status ?? '-'}  ${paid}${cache}  ${result.url}\n`);
  if (result.capability) {
    process.stdout.write(
      `capability ${result.capability} -> ${result.provider?.url ?? result.url}\n`,
    );
  }
  if (result.warnings) for (const w of result.warnings) writeErr(`warning: ${w}`);
  if (result.dryRun && result.selected) {
    const o = result.selected;
    process.stdout.write(
      `would pay ${o.amount} ${o.assetSymbol} to ${o.payTo} on ${o.network} (scheme ${o.scheme})\n`,
    );
  }
  if (result.error) writeErr(result.error);
  if (!opts.out && bodyText !== '') {
    process.stdout.write(bodyText.endsWith('\n') ? bodyText : `${bodyText}\n`);
  }
  if (result.paid) process.stdout.write(`receipt ${result.receiptId}\n`);
}
