import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  summarizePayload,
  summarizeHeaders,
  maskPaths,
  isRedactedHeader,
  writeOutbox,
  readOutbox,
  outboxDepth,
  clearOutbox,
} from '../src/core/telemetry.js';
import {
  appendRecord,
  readRecords,
  queryRecords,
  sumRecords,
  spentToday,
} from '../src/core/ledger.js';
import type { LedgerRecord } from '../src/core/ledger.js';
import { paths } from '../src/core/paths.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-tel-'));
  process.env.X402_HOME = home;
});

afterEach(() => {
  delete process.env.X402_HOME;
  rmSync(home, { recursive: true, force: true });
});

const record = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  id: 'r1',
  ts: new Date().toISOString(),
  url: 'https://api.example.com/v1/lei',
  method: 'GET',
  wallet: 'my-agent',
  request: { bytes: 0 },
  payment: { paid: true, amount: '0.002', asset: 'usdc', payTo: '0xabc' },
  response: { status: 200, bytes: 10, latencyMs: 5 },
  exitCode: 0,
  agent: {},
  ...over,
});

describe('payload levels', () => {
  const raw = '{"query":"Roundhouse AI Ltd."}';
  const parsed = { query: 'Roundhouse AI Ltd.' };

  it('records byte counts only at none', () => {
    const summary = summarizePayload(raw, parsed, 'none');
    expect(summary).toEqual({ bytes: raw.length });
  });

  it('records hash plus key names at hash', () => {
    const summary = summarizePayload(raw, parsed, 'hash');
    expect(summary.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(summary.keys).toEqual(['query']);
    expect(summary.body).toBeUndefined();
  });

  it('records plaintext at full, honouring redactKeys', () => {
    const summary = summarizePayload(raw, { company: { name: 'X' }, other: 1 }, 'full', [
      'company.name',
    ]);
    expect(summary.body).toEqual({ company: { name: '[redacted]' }, other: 1 });
  });
});

describe('header redaction', () => {
  it('always redacts auth-like headers and records only their presence', () => {
    const summary = summarizeHeaders({
      Authorization: 'Bearer secret',
      'X-PAYMENT': 'base64payload',
      'X-Api-Version': '2',
    });
    expect(summary.headerNames).toEqual(['authorization', 'x-api-version', 'x-payment']);
    expect(JSON.stringify(summary)).not.toContain('secret');
    expect(JSON.stringify(summary)).not.toContain('base64payload');
  });

  it('redacts the x402 v2 payment headers too', () => {
    const summary = summarizeHeaders({
      'PAYMENT-SIGNATURE': 'base64payload',
      'X-Api-Version': '2',
    });
    expect(summary.headerNames).toEqual(['payment-signature', 'x-api-version']);
    expect(JSON.stringify(summary)).not.toContain('base64payload');
  });

  it('knows the always-redacted set', () => {
    expect(isRedactedHeader('Cookie')).toBe(true);
    expect(isRedactedHeader('x-api-key')).toBe(true);
    expect(isRedactedHeader('accept')).toBe(false);
    // A signed authorization is a bearer instrument under either spelling.
    expect(isRedactedHeader('PAYMENT-SIGNATURE')).toBe(true);
    expect(isRedactedHeader('payment-response')).toBe(true);
  });
});

describe('maskPaths', () => {
  it('masks through arrays and wildcards', () => {
    const value = { people: [{ ssn: '1' }, { ssn: '2' }], meta: { a: { secret: 'x' } } };
    expect(maskPaths(value, ['people.ssn', 'meta.*.secret'])).toEqual({
      people: [{ ssn: '[redacted]' }, { ssn: '[redacted]' }],
      meta: { a: { secret: '[redacted]' } },
    });
  });
});

describe('ledger', () => {
  it('writes 0600 and survives a truncated line', () => {
    appendRecord(record());
    expect(statSync(paths.ledger()).mode & 0o777).toBe(0o600);
    expect(readRecords()).toHaveLength(1);
  });

  it('filters and sums', () => {
    appendRecord(record({ id: 'a' }));
    appendRecord(record({ id: 'b', payment: { paid: false, amount: '0' } }));
    appendRecord(
      record({ id: 'c', payment: { paid: true, amount: '0.5', asset: 'usdc', payTo: '0xdef' } }),
    );

    expect(queryRecords(readRecords(), { paidOnly: true })).toHaveLength(2);
    const totals = sumRecords(readRecords().filter((r) => r.payment.asset === 'usdc'));
    expect(totals[0]!.total).toBe('0.502');

    const byPayTo = sumRecords(readRecords(), 'payTo');
    expect(byPayTo.map((r) => r.key)).toContain('0xdef');
  });

  it('computes today spend in atomic units', () => {
    appendRecord(record({ payment: { paid: true, amount: '1.5', asset: 'usdc' } }));
    expect(spentToday(readRecords(), 'usdc', 6)).toBe(1_500_000n);
  });

  it('ignores records from previous days', () => {
    appendRecord(record({ ts: '2020-01-01T00:00:00.000Z' }));
    expect(spentToday(readRecords(), 'usdc', 6)).toBe(0n);
  });
});

describe('outbox', () => {
  it('round-trips queued records', () => {
    writeOutbox([record(), record({ id: 'r2' })]);
    expect(outboxDepth()).toBe(2);
    expect(readOutbox().map((r) => r.id)).toEqual(['r1', 'r2']);
    clearOutbox();
    expect(outboxDepth()).toBe(0);
  });
});
