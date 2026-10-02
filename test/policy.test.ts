import { describe, it, expect } from 'vitest';
import {
  applyCounterpartyPolicy,
  DEFAULT_SPOT_FACTOR,
  type Provider,
} from '../src/core/discover.js';

const offer = (over: Partial<Provider> = {}): Provider => ({
  url: 'https://provider.example/v1',
  capability: 'web-search',
  price: '0.01',
  live: true,
  payers30d: 12,
  source: 'index',
  ...over,
});

const stats = { spot: '0.01' };

describe('the default counterparty rule', () => {
  it('passes a live, paid-by-someone offer at the going rate', () => {
    const r = applyCounterpartyPolicy([offer()], stats);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toHaveLength(0);
    expect(r.priceRule).toBe('applied');
  });

  it('allows up to 1.5 times spot and no more', () => {
    expect(DEFAULT_SPOT_FACTOR).toBe(1.5);
    const r = applyCounterpartyPolicy(
      [
        offer({ price: '0.015', url: 'https://a.example' }),
        offer({ price: '0.016', url: 'https://b.example' }),
      ],
      stats,
    );
    expect(r.accepted.map((p) => p.url)).toEqual(['https://a.example']);
    expect(r.rejected[0]?.reasons.join(' ')).toContain('above 1.5x');
  });

  it('honours a different factor', () => {
    const r = applyCounterpartyPolicy([offer({ price: '0.02' })], stats, 2);
    expect(r.accepted).toHaveLength(1);
  });

  it('rejects an offer that is down, and one whose liveness is unknown', () => {
    const r = applyCounterpartyPolicy([offer({ live: false }), offer({ live: undefined })], stats);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]?.reasons).toContain('not live at the last probe');
    expect(r.rejected[1]?.reasons).toContain('liveness unknown');
  });

  it('rejects an offer nobody has paid in 30 days, and one with no payer data', () => {
    const r = applyCounterpartyPolicy(
      [offer({ payers30d: 0 }), offer({ payers30d: undefined })],
      stats,
    );
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]?.reasons.join(' ')).toContain('no paying customers');
    expect(r.rejected[1]?.reasons.join(' ')).toContain('no payer count');
  });

  it('reports every rule an offer failed, not just the first', () => {
    const r = applyCounterpartyPolicy([offer({ live: false, payers30d: 0, price: '9' })], stats);
    expect(r.rejected[0]?.reasons).toHaveLength(3);
  });

  it('rejects an unpriced offer when there is a going rate to compare with', () => {
    const r = applyCounterpartyPolicy([offer({ price: undefined })], stats);
    expect(r.rejected[0]?.reasons.join(' ')).toContain('no listed price');
  });

  it('says it skipped the price rule when the market reports no spot, rather than passing silently', () => {
    const r = applyCounterpartyPolicy([offer({ price: '999' })], undefined);
    expect(r.priceRule).toBe('skipped');
    expect(r.spot).toBeNull();
    expect(r.accepted).toHaveLength(1);
  });

  it('still applies the liveness and payer rules when the price rule is skipped', () => {
    const r = applyCounterpartyPolicy([offer({ live: false })], undefined);
    expect(r.accepted).toHaveLength(0);
  });
});
