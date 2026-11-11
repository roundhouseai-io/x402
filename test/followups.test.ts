import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, mergeDeep } from '../src/core/config.js';
import { Engine } from '../src/core/engine.js';
import { SessionBudget } from '../src/core/gates.js';
import { ExitCode, ExitCodeName } from '../src/core/errors.js';
import type { TypedDataDocument } from '../src/core/eip3009.js';
import { readRecords, spentToday } from '../src/core/ledger.js';
import { publicResponseHeaders, toEnvelope } from '../src/core/output.js';
import type { SignerBackend } from '../src/core/signer.js';
import {
  AMOUNT_TOO_LOW_HINT,
  isAmountTooLow,
  quoteWarnings,
  settledAtomic,
  settlementFailure,
  settlementFromStream,
} from '../src/core/settlement.js';
import { parsePaymentRequired } from '../src/core/x402.js';
import { parseArgs } from '../src/core/args.js';
import { flagsFrom } from '../src/commands/setup.js';
import { providerRejection } from '../src/core/engine.js';

const PAY_TO = '0x2222222222222222222222222222222222222222';
const FACILITATOR = '0x0000000000000000000000000000000000000001';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYER = '0x1111111111111111111111111111111111111111';
const URL = 'https://ioi.example/v1/chat/completions';

const upto = (amount = '12345') => ({
  scheme: 'upto',
  network: 'eip155:8453',
  amount,
  asset: USDC_BASE,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2', facilitatorAddress: FACILITATOR },
});

const quote = (accepts: unknown[]) => ({
  x402Version: 2,
  error: 'Payment required',
  resource: { url: URL, mimeType: 'application/json' },
  accepts,
});

const header = (payload: unknown) => ({
  'payment-required': Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
});
const receipt = (body: unknown) => ({
  'payment-response': Buffer.from(JSON.stringify(body), 'utf8').toString('base64'),
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

class FakeSigner implements SignerBackend {
  readonly backend = 'fake';
  readonly wallet = 'test-wallet';
  signed: TypedDataDocument[] = [];
  async capabilities() {
    return { typedData: true, policies: true, balances: false, accounts: true, declared: true };
  }
  async getAccounts() {
    return [{ id: this.wallet, address: PAYER }];
  }
  async getAddress(): Promise<string> {
    return PAYER;
  }
  async signTypedData(typedData: TypedDataDocument): Promise<string> {
    this.signed.push(typedData);
    return `0x${'cd'.repeat(32)}00`;
  }
}

let home: string;
let fetchMock: ReturnType<typeof vi.fn>;

const NOW = 1_700_000_000_000;
const engineFor = (signer: SignerBackend, budget?: SessionBudget, limits = {}) =>
  new Engine({
    config: mergeDeep(DEFAULT_CONFIG, { limits: { maxPerCall: '1.00', ...limits } }),
    signer: async () => signer,
    budget,
    walletName: signer.wallet,
    backendName: signer.backend,
    now: () => NOW,
  });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-followups-'));
  process.env.X402_HOME = home;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.X402_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('settledAtomic', () => {
  const ok = { success: true } as const;
  it('reads the amount a receipt reports, within the signed amount', () => {
    expect(settledAtomic({ ...ok, amount: '3939' }, 12345n)).toBe(3939n);
    expect(settledAtomic({ ...ok, amount: 3939 }, 12345n)).toBe(3939n);
    expect(settledAtomic({ ...ok, amount: '12345' }, 12345n)).toBe(12345n);
  });
  it('answers unknown, never a low guess, when the receipt is not usable', () => {
    expect(settledAtomic(undefined, 100n)).toBeUndefined();
    expect(settledAtomic({ ...ok }, 100n)).toBeUndefined();
    expect(settledAtomic({ success: false, amount: '5' }, 100n)).toBeUndefined();
    expect(settledAtomic({ ...ok, amount: '1.5' }, 100n)).toBeUndefined();
    expect(settledAtomic({ ...ok, amount: '-5' }, 100n)).toBeUndefined();
    expect(settledAtomic({ ...ok, amount: '101' }, 100n)).toBeUndefined();
  });
});

describe('settlementFromStream', () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"Yo"}}]}',
    '',
    'data: {"id":"x402-settlement","object":"chat.completion.chunk","choices":[],"x402_settlement":{"ok":true,"transaction":"0xabc","payer":"0xPayer","network":"eip155:8453","amount":"3939","model":"m","tokens_in":20,"tokens_out":4}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  it('reads the last x402_settlement frame', () => {
    expect(settlementFromStream(body)).toEqual({
      success: true,
      transaction: '0xabc',
      payer: '0xPayer',
      network: 'eip155:8453',
      amount: '3939',
    });
  });
  it('reports a failed settlement frame as not successful, with the message', () => {
    const failed = body.replace('"ok":true', '"ok":false,"message":"amount_too_low"');
    const s = settlementFromStream(failed)!;
    expect(s.success).toBe(false);
    expect(s.errorReason).toBe('amount_too_low');
  });
  it('is undefined when there is no frame, and skips a frame that is not JSON', () => {
    expect(settlementFromStream('data: {"choices":[]}\n\ndata: [DONE]\n')).toBeUndefined();
    expect(settlementFromStream('data: x402_settlement {not json\n')).toBeUndefined();
  });
});

describe('settlementFailure', () => {
  const body = JSON.stringify({
    error: {
      code: 'settlement_failed',
      message: 'Settlement failed after inference: amount_too_low',
    },
  });
  it('recognises the OpenAI-shaped settlement_failed error on a 5xx', () => {
    expect(settlementFailure(502, body)).toMatch(/amount_too_low/);
  });
  it('ignores anything else', () => {
    expect(settlementFailure(200, body)).toBeUndefined();
    expect(settlementFailure(402, body)).toBeUndefined();
    expect(settlementFailure(502, '{"error":{"code":"upstream_error"}}')).toBeUndefined();
    expect(settlementFailure(502, 'not json')).toBeUndefined();
  });
});

describe('amount_too_low', () => {
  it('is recognised in any spelling', () => {
    expect(isAmountTooLow('amount_too_low')).toBe(true);
    expect(isAmountTooLow('Amount too low')).toBe(true);
    expect(isAmountTooLow('allowance_required')).toBe(false);
  });

  const res = (body: string) => ({ status: 402, headers: {}, body, url: URL }) as never;
  it('adds the minimum to a bare string error', () => {
    const msg = providerRejection(res('{"error":"amount_too_low"}'), undefined);
    expect(msg).toContain('amount_too_low');
    expect(msg).toContain(AMOUNT_TOO_LOW_HINT);
    expect(msg).toContain('0.001 USDC');
  });
  it('passes the provider code and message through from an OpenAI-shaped error', () => {
    const msg = providerRejection(
      res('{"error":{"code":"amount_too_low","message":"Payment of 9 is under the minimum"}}'),
      undefined,
    );
    expect(msg).toContain('amount_too_low');
    expect(msg).toContain('under the minimum');
    expect(msg).toContain('max_tokens');
  });
  it('adds no hint to an unrelated rejection', () => {
    const msg = providerRejection(res('{"error":"authorization expired"}'), undefined);
    expect(msg).toContain('authorization expired');
    expect(msg).not.toContain(AMOUNT_TOO_LOW_HINT);
  });
});

describe('quote warnings', () => {
  const optionOf = (amount: string, asset = USDC_BASE) =>
    parsePaymentRequired(quote([{ ...upto(amount), asset }])).options[0]!;
  it('warns below 1000 atomic units of USDC', () => {
    const w = quoteWarnings(optionOf('9'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('amount_too_low');
    expect(w[0]).toContain('9 atomic units');
  });
  it('is quiet at and above the minimum, and for a free quote', () => {
    expect(quoteWarnings(optionOf('1000'))).toEqual([]);
    expect(quoteWarnings(optionOf('12345'))).toEqual([]);
    expect(quoteWarnings(optionOf('0'))).toEqual([]);
  });
});

describe('response headers in the envelope', () => {
  it('keeps the provider x-* headers and drops anything credential-like', () => {
    const headers = publicResponseHeaders({
      'x-canary-price-usd': '$0.003939',
      'x-canary-venue': 'engy',
      'x-canary-x402-tx': '0xabc',
      'x-canary-x402-scheme': 'upto',
      'x-payment-response': 'secret-receipt',
      'x-api-key': 'k',
      'x-auth-token': 't',
      'x-session-id': 's',
      'set-cookie': 'a=b',
      'content-type': 'application/json',
      'payment-response': 'r',
    });
    expect(headers).toEqual({
      'x-canary-price-usd': '$0.003939',
      'x-canary-venue': 'engy',
      'x-canary-x402-tx': '0xabc',
      'x-canary-x402-scheme': 'upto',
    });
  });
  it('omits the field when there is nothing to show', () => {
    expect(publicResponseHeaders(undefined)).toEqual({});
    expect(publicResponseHeaders({ 'content-type': 'text/plain' })).toEqual({});
  });
  it('puts them in the call envelope', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([upto()]))))
      .mockResolvedValueOnce(
        json(200, { ok: true }, { 'x-canary-price-usd': '$0.003939', 'set-cookie': 'a=b' }),
      );
    const result = await engineFor(new FakeSigner()).call({ target: URL, data: {} });
    const env = toEnvelope(result);
    expect(env.response).toEqual({ headers: { 'x-canary-price-usd': '$0.003939' } });
  });
});

describe('what an upto payment is counted as', () => {
  it('records the settled amount, keeps the ceiling, and counts the settled amount against the day and the session', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([upto('12345')]))))
      .mockResolvedValueOnce(
        json(200, { ok: true }, receipt({ success: true, transaction: '0xtx', amount: '3939' })),
      );
    const budget = new SessionBudget(1_000_000n);
    const result = await engineFor(new FakeSigner(), budget).call({ target: URL, data: {} });

    expect(result.ok).toBe(true);
    expect(result.paymentState).toBe('settled');
    expect(result.amount).toBe('0.003939');
    expect(result.ceiling).toBe('0.012345');
    expect(result.receipt?.amountAtomic).toBe('12345');
    expect(result.receipt?.settledAmount).toBe('0.003939');
    expect(toEnvelope(result).ceiling).toBe('0.012345');

    const [record] = readRecords();
    expect(record!.payment.amount).toBe('0.003939');
    expect(record!.payment.ceiling).toBe('0.012345');
    expect(spentToday(readRecords(), 'usdc', 6, NOW)).toBe(3939n);
    expect(budget.remaining()).toBe(1_000_000n - 3939n);
  });

  it('falls back to the signed amount when no settled amount is reported', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([upto('12345')]))))
      .mockResolvedValueOnce(
        json(200, { ok: true }, receipt({ success: true, transaction: '0xtx' })),
      );
    const result = await engineFor(new FakeSigner()).call({ target: URL, data: {} });
    expect(result.amount).toBe('0.012345');
    expect(result.ceiling).toBeUndefined();
    expect(spentToday(readRecords(), 'usdc', 6, NOW)).toBe(12345n);
  });

  it('does not believe a settled amount above the signature', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([upto('12345')]))))
      .mockResolvedValueOnce(
        json(200, { ok: true }, receipt({ success: true, transaction: '0xtx', amount: '99999' })),
      );
    const result = await engineFor(new FakeSigner()).call({ target: URL, data: {} });
    expect(result.amount).toBe('0.012345');
  });

  it('reads the settlement from a stream whose headers carried none', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Yo"}}]}',
      '',
      'data: {"x402_settlement":{"ok":true,"transaction":"0xabc","payer":"0xP","network":"eip155:8453","amount":"3939"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([upto('12345')]))))
      .mockResolvedValueOnce(
        new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    const result = await engineFor(new FakeSigner()).call({ target: URL, data: { stream: true } });
    expect(result.paymentState).toBe('settled');
    expect(result.amount).toBe('0.003939');
    expect(result.receipt?.settlement).toMatchObject({ transaction: '0xabc', success: true });
    expect(spentToday(readRecords(), 'usdc', 6, NOW)).toBe(3939n);
  });
});

describe('gates read the signed ceiling', () => {
  it('refuses a ceiling over --max even though upto would settle less, and signs nothing', async () => {
    fetchMock.mockResolvedValueOnce(json(402, {}, header(quote([upto('12345')]))));
    const signer = new FakeSigner();
    const result = await engineFor(signer).call({ target: URL, data: {}, max: '0.01' });
    expect(result.errorCode).toBe(ExitCode.OVER_MAX);
    expect(signer.signed).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a settlement the provider could not complete', () => {
  const failure = {
    error: {
      code: 'settlement_failed',
      message:
        'Settlement failed after inference: amount_too_low The authorization was not captured.',
    },
  };

  it('is not paid and not "paid, no response": nothing moved, exit 51, one request only', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([upto('9')]))))
      .mockResolvedValueOnce(json(502, failure));
    const budget = new SessionBudget(1_000_000n);
    const result = await engineFor(new FakeSigner(), budget).call({ target: URL, data: {} });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.paid).toBe(false);
    expect(result.paymentState).toBe('signed');
    expect(result.amount).toBe('0');
    expect(result.errorCode).toBe(ExitCode.SETTLEMENT_FAILED);
    expect(ExitCode.SETTLEMENT_FAILED).not.toBe(ExitCode.PAID_NO_RESPONSE);
    expect(ExitCodeName[51]).toBe('settlement_failed');
    expect(result.error).toContain('Settlement failed after inference');
    expect(result.error).toContain('nothing was paid');
    expect(result.error).toContain(AMOUNT_TOO_LOW_HINT);

    const [record] = readRecords();
    expect(record!.payment.paid).toBe(false);
    expect(record!.payment.state).toBe('signed');
    expect(record!.payment.amount).toBe('0');
    expect(record!.exitCode).toBe(51);
    expect(spentToday(readRecords(), 'usdc', 6, NOW)).toBe(0n);
    expect(budget.remaining()).toBe(1_000_000n);
    // No automatic retry: the 402 and the one paid attempt.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still treats an ordinary 502 after payment as paid, no response (50)', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([upto('12345')]))))
      .mockResolvedValueOnce(json(502, { error: { code: 'upstream_error', message: 'boom' } }));
    const result = await engineFor(new FakeSigner()).call({ target: URL, data: {} });
    expect(result.paid).toBe(true);
    expect(result.errorCode).toBe(ExitCode.PAID_NO_RESPONSE);
  });
});

describe('a payment the provider rejects as too small', () => {
  it('carries the provider code and the minimum in the error, and signed-not-paid', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([upto('9')]))))
      .mockResolvedValueOnce(json(402, { error: 'amount_too_low' }, header(quote([upto('9')]))));
    const result = await engineFor(new FakeSigner()).call({ target: URL, data: {} });
    expect(result.paid).toBe(false);
    expect(result.paymentState).toBe('signed');
    expect(result.errorCode).toBe(ExitCode.INVALID_402);
    expect(result.error).toContain('amount_too_low');
    expect(result.error).toContain('0.001 USDC');
  });
});

describe('warnings before paying', () => {
  it('shows up in a dry run, and the dry run signs nothing', async () => {
    fetchMock.mockResolvedValueOnce(json(402, {}, header(quote([upto('9')]))));
    const signer = new FakeSigner();
    const result = await engineFor(signer).call({ target: URL, data: {}, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.warnings?.[0]).toContain('amount_too_low');
    expect(toEnvelope(result).warnings).toHaveLength(1);
    expect(signer.signed).toHaveLength(0);
  });
  it('shows up in probe, and is absent for a healthy quote', async () => {
    fetchMock.mockResolvedValueOnce(json(402, {}, header(quote([upto('9')]))));
    const probe = await engineFor(new FakeSigner()).probe({ target: URL, data: {} });
    expect(probe.warnings).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(json(402, {}, header(quote([upto('12345')]))));
    const fine = await engineFor(new FakeSigner()).probe({ target: URL, data: {} });
    expect(fine.warnings).toBeUndefined();
  });
});

describe('setup allows Permit2 by default', () => {
  const flagsOf = (...argv: string[]) => flagsFrom(parseArgs(['setup', ...argv]));
  it('on by default, off with --no-allow-permit2', () => {
    expect(flagsOf('--path', 'ows', '--yes').allowPermit2).toBe(true);
    expect(flagsOf('--path', 'ows', '--yes', '--no-allow-permit2').allowPermit2).toBe(false);
  });
});
