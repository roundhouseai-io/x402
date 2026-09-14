import { existsSync, readFileSync } from 'node:fs';
import { paths, appendPrivate } from './paths.js';

export interface LedgerRecord {
  id: string;
  ts: string;
  url: string;
  method: string;
  wallet: string | null;
  /** Signer backend that produced the authorization. */
  backend?: string;
  capability?: string;
  provider?: string;
  request: {
    dataHash?: string;
    dataKeys?: string[];
    data?: unknown;
    headersHash?: string;
    headerNames?: string[];
    bytes: number;
  };
  payment: {
    /**
     * Whether the wallet should be assumed to have spent. True from `submitted`
     * onwards; `spentToday` and the daily cap count these records.
     */
    paid: boolean;
    /**
     * How far the payment got: none | signed | submitted | settled.
     * Optional because records written before this field existed have none.
     */
    state?: 'none' | 'signed' | 'submitted' | 'settled';
    /** x402 protocol version the payment was constructed for. */
    x402Version?: number;
    amount: string;
    asset?: string;
    chain?: string;
    payTo?: string;
    scheme?: string;
    authHash?: string;
    cacheHit?: boolean;
    settlement?: unknown;
  };
  response: {
    status: number | null;
    bodyHash?: string;
    body?: unknown;
    bytes: number;
    latencyMs: number;
    paymentLatencyMs?: number;
  };
  exitCode: number;
  error?: string;
  agent: { session?: string; tag?: string; token?: string };
}

export function appendRecord(record: LedgerRecord, file = paths.ledger()): void {
  appendPrivate(file, `${JSON.stringify(record)}\n`);
}

export function readRecords(file = paths.ledger()): LedgerRecord[] {
  if (!existsSync(file)) return [];
  const out: LedgerRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed) as LedgerRecord);
    } catch {
      // A truncated final line (process killed mid-write) must not break history.
    }
  }
  return out;
}

/** Parse `24h`, `30m`, `7d`, `2026-08-26` or a full ISO timestamp. */
export function parseSince(input: string, now = Date.now()): number {
  const rel = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(input.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!;
    const ms = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[unit]!;
    return now - n * ms;
  }
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) throw new Error(`cannot parse time: ${input}`);
  return parsed;
}

export interface HistoryQuery {
  since?: string;
  until?: string;
  paidOnly?: boolean;
  limit?: number;
  wallet?: string;
  token?: string;
  url?: string;
  now?: number;
}

export function queryRecords(records: LedgerRecord[], q: HistoryQuery = {}): LedgerRecord[] {
  const now = q.now ?? Date.now();
  const from = q.since ? parseSince(q.since, now) : undefined;
  const to = q.until ? parseSince(q.until, now) : undefined;

  let out = records.filter((r) => {
    const ts = Date.parse(r.ts);
    if (from !== undefined && ts < from) return false;
    if (to !== undefined && ts > to) return false;
    if (q.paidOnly && !r.payment.paid) return false;
    if (q.wallet && r.wallet !== q.wallet) return false;
    if (q.token && r.agent?.token !== q.token) return false;
    if (q.url && !r.url.includes(q.url)) return false;
    return true;
  });
  if (q.limit !== undefined && q.limit > 0) out = out.slice(-q.limit);
  return out;
}

export type GroupKey = 'payTo' | 'url' | 'wallet' | 'asset' | 'agent' | 'day' | 'capability';

export const GROUP_KEYS: GroupKey[] = [
  'payTo',
  'url',
  'wallet',
  'asset',
  'agent',
  'day',
  'capability',
];

function groupValue(r: LedgerRecord, by: GroupKey): string {
  switch (by) {
    case 'payTo':
      return r.payment.payTo ?? '(unpaid)';
    case 'url':
      return r.url;
    case 'wallet':
      return r.wallet ?? '(none)';
    case 'asset':
      return r.payment.asset ?? '(none)';
    case 'agent':
      return r.agent?.token ?? r.agent?.tag ?? '(none)';
    case 'capability':
      return r.capability ?? '(none)';
    case 'day':
      return r.ts.slice(0, 10);
  }
}

export interface SumRow {
  key: string;
  asset: string;
  calls: number;
  paidCalls: number;
  total: string;
}

/** Ledger amounts are human decimals; 6dp represents USDC exactly. */
function toMicro(amount: string): bigint {
  const [whole = '0', frac = ''] = String(amount ?? '0').split('.');
  return BigInt(whole || '0') * 1000000n + BigInt((frac + '000000').slice(0, 6) || '0');
}

function fromMicro(micro: bigint): string {
  const whole = micro / 1000000n;
  const frac = (micro % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}`;
}

/** Sum spend, optionally grouped. */
export function sumRecords(records: LedgerRecord[], by?: GroupKey): SumRow[] {
  const buckets = new Map<
    string,
    { key: string; asset: string; calls: number; paid: number; micro: bigint }
  >();
  for (const r of records) {
    const asset = r.payment.asset ?? 'none';
    const key = by ? groupValue(r, by) : 'all';
    const id = `${key} ${asset}`;
    const bucket = buckets.get(id) ?? { key, asset, calls: 0, paid: 0, micro: 0n };
    bucket.calls++;
    if (r.payment.paid) {
      bucket.paid++;
      bucket.micro += toMicro(r.payment.amount);
    }
    buckets.set(id, bucket);
  }
  return [...buckets.values()]
    .map((b) => ({
      key: b.key,
      asset: b.asset,
      calls: b.calls,
      paidCalls: b.paid,
      total: fromMicro(b.micro),
      micro: b.micro,
    }))
    .sort((a, b) => (a.micro === b.micro ? a.key.localeCompare(b.key) : a.micro > b.micro ? -1 : 1))
    .map(({ micro: _micro, ...row }) => row);
}

/** Spend since UTC midnight, in atomic units of `asset`, for the daily-cap gate. */
export function spentToday(
  records: LedgerRecord[],
  asset: string,
  decimals: number,
  now = Date.now(),
): bigint {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  let micro = 0n;
  for (const r of records) {
    if (!r.payment.paid) continue;
    if (Date.parse(r.ts) < dayStart.getTime()) continue;
    if (asset && r.payment.asset && r.payment.asset !== asset) continue;
    micro += toMicro(r.payment.amount);
  }
  return decimals >= 6 ? micro * 10n ** BigInt(decimals - 6) : micro / 10n ** BigInt(6 - decimals);
}
