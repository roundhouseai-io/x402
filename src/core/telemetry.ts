import { readdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { paths, ensureDir, writePrivate } from './paths.js';
import { tagged, ulid } from './ids.js';
import { request } from './http.js';
import type { PayloadLevel, X402Config } from './config.js';
import type { LedgerRecord } from './ledger.js';

/**
 * Header names that are redacted at every payload level. Only their presence is
 * recorded. This list is not configurable downwards.
 */
export const ALWAYS_REDACTED_HEADERS = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  'x-payment',
  'x-payment-response',
];

export function isRedactedHeader(name: string): boolean {
  return ALWAYS_REDACTED_HEADERS.includes(name.toLowerCase());
}

export interface HeaderSummary {
  headerNames: string[];
  headersHash: string;
}

/** Record header names always; hash only the non-sensitive values. */
export function summarizeHeaders(headers: Record<string, string>): HeaderSummary {
  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const safe = names
    .filter((n) => !isRedactedHeader(n))
    .map(
      (n) =>
        `${n}:${headers[n] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === n)!] ?? ''}`,
    );
  return { headerNames: names, headersHash: tagged(safe.join('\n')) };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-clone `value`, replacing every configured dot path with a marker. */
export function maskPaths(value: unknown, dotPaths: string[]): unknown {
  if (dotPaths.length === 0) return value;
  const clone = structuredClone(value);
  for (const path of dotPaths) {
    const segments = path.split('.');
    applyMask(clone, segments);
  }
  return clone;
}

function applyMask(node: unknown, segments: string[]): void {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) applyMask(item, segments);
    return;
  }
  if (!isObj(node)) return;
  if (rest.length === 0) {
    if (head in node) node[head] = '[redacted]';
    return;
  }
  if (head === '*') {
    for (const v of Object.values(node)) applyMask(v, rest);
    return;
  }
  applyMask(node[head], rest);
}

export interface PayloadSummary {
  hash?: string;
  keys?: string[];
  body?: unknown;
  bytes: number;
}

/**
 * Summarize a payload at the configured level.
 * `hash` is the default on purpose: a default-on plaintext log of every payload
 * is a data-protection liability, and agents push personal data through here.
 */
export function summarizePayload(
  raw: string,
  parsed: unknown,
  level: PayloadLevel,
  redactKeys: string[] = [],
): PayloadSummary {
  const bytes = Buffer.byteLength(raw ?? '');
  if (level === 'none') return { bytes };
  const keys = isObj(parsed) ? Object.keys(parsed).sort() : undefined;
  if (level === 'hash') {
    return { hash: tagged(raw ?? ''), ...(keys ? { keys } : {}), bytes };
  }
  const body =
    parsed === undefined ? (raw === '' ? undefined : raw) : maskPaths(parsed, redactKeys);
  return { hash: tagged(raw ?? ''), ...(keys ? { keys } : {}), body, bytes };
}

/** Values the ledger records for the calling agent. */
export function agentContext(env: NodeJS.ProcessEnv = process.env): LedgerRecord['agent'] {
  const out: LedgerRecord['agent'] = {};
  if (env.X402_SESSION) out.session = env.X402_SESSION;
  if (env.X402_AGENT) out.tag = env.X402_AGENT;
  return out;
}

/**
 * Remote sink. Batches records, queues to `~/.x402/outbox/` on failure, and
 * flushes the outbox on the next invocation. Sink failures never fail a call.
 */
export class TelemetrySink {
  private queue: LedgerRecord[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly config: X402Config) {}

  get enabled(): boolean {
    const sink = this.config.telemetry.sink;
    return Boolean(sink.enabled && sink.url);
  }

  enqueue(record: LedgerRecord): void {
    if (!this.enabled) return;
    this.queue.push(record);
    if (this.queue.length >= this.config.telemetry.sink.batchSize) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.config.telemetry.sink.batchIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Post pending records plus anything sitting in the outbox. Never throws. */
  async flush(): Promise<{ sent: number; queued: number }> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.enabled) {
      this.queue = [];
      return { sent: 0, queued: 0 };
    }
    const batch = [...this.queue, ...readOutbox()];
    this.queue = [];
    if (batch.length === 0) return { sent: 0, queued: 0 };

    const ok = await this.post(batch);
    if (ok) {
      clearOutbox();
      return { sent: batch.length, queued: 0 };
    }
    writeOutbox(batch);
    return { sent: 0, queued: batch.length };
  }

  private async post(records: LedgerRecord[]): Promise<boolean> {
    const sink = this.config.telemetry.sink;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (sink.token) headers.authorization = `Bearer ${sink.token}`;
    try {
      const res = await request({
        url: sink.url!,
        method: 'POST',
        headers,
        body: JSON.stringify({ records }),
        timeoutMs: 10_000,
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }
}

export function readOutbox(dir = paths.outbox()): LedgerRecord[] {
  if (!existsSync(dir)) return [];
  const out: LedgerRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as LedgerRecord);
      } catch {
        /* skip corrupt line */
      }
    }
  }
  return out;
}

export function writeOutbox(records: LedgerRecord[], dir = paths.outbox()): void {
  if (records.length === 0) return;
  ensureDir(dir);
  clearOutbox(dir);
  writePrivate(
    join(dir, `${ulid()}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

export function clearOutbox(dir = paths.outbox()): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.jsonl')) unlinkSync(join(dir, name));
  }
}

export function outboxDepth(dir = paths.outbox()): number {
  return readOutbox(dir).length;
}
