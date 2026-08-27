import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, mergeDeep, type X402Config } from '../src/core/config.js';
import { Engine, prepareRequest, inferMethod } from '../src/core/engine.js';
import { SessionBudget } from '../src/core/gates.js';
import { ExitCode } from '../src/core/errors.js';
import { decodePaymentHeader } from '../src/core/eip3009.js';
import { readRecords } from '../src/core/ledger.js';
import type { SignerBackend } from '../src/core/signer.js';
import type { TypedData } from '../src/core/eip3009.js';

const PAY_TO = '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const requirements = (amountAtomic = '2000') => ({
  x402Version: 1,
  error: 'payment required',
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: amountAtomic,
      payTo: PAY_TO,
      asset: USDC_BASE,
      maxTimeoutSeconds: 120,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
});

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

class FakeSigner implements SignerBackend {
  readonly backend = 'fake';
  readonly wallet = 'test-wallet';
  signed: TypedData[] = [];
  constructor(private readonly opts: { balance?: string; fail?: Error } = {}) {}
  async capabilities() {
    return { typedData: true, policies: true, balances: true, accounts: true, declared: true };
  }
  async getAccounts() {
    return [{ id: this.wallet, address: await this.getAddress() }];
  }
  async getAddress(): Promise<string> {
    return '0x000000000000000000000000000000000000dEaD';
  }
  async signTypedData(typedData: TypedData): Promise<string> {
    if (this.opts.fail) throw this.opts.fail;
    this.signed.push(typedData);
    return `0x${'ab'.repeat(32)}${(this.signed.length - 1).toString(16).padStart(2, '0')}`;
  }
  async getBalance() {
    return this.opts.balance === undefined
      ? undefined
      : { asset: 'usdc', amount: this.opts.balance, decimals: 6 };
  }
}

let home: string;
let fetchMock: ReturnType<typeof vi.fn>;

function makeEngine(
  overrides: Partial<X402Config> = {},
  signer: SignerBackend = new FakeSigner(),
  budget?: SessionBudget,
) {
  const config = mergeDeep(DEFAULT_CONFIG, overrides);
  return new Engine({
    config,
    signer: async () => signer,
    budget,
    walletName: signer.wallet,
    backendName: signer.backend,
    now: () => 1_700_000_000_000,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-test-'));
  process.env.X402_HOME = home;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.X402_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('prepareRequest', () => {
  it('flattens data to query params for GET', () => {
    const prepared = prepareRequest(
      'https://api.example.com/v1/lei',
      { query: 'Roundhouse AI Ltd.' },
      {
        method: 'GET',
      },
    );
    expect(prepared.url).toBe('https://api.example.com/v1/lei?query=Roundhouse+AI+Ltd.');
    expect(prepared.body).toBeUndefined();
  });

  it('sends a JSON body for POST', () => {
    const prepared = prepareRequest('https://api.example.com/v1/screen', { a: 1 }, {});
    expect(prepared.method).toBe('POST');
    expect(prepared.body).toBe('{"a":1}');
    expect(prepared.headers['content-type']).toBe('application/json');
  });

  it('forces a body with --body-always', () => {
    const prepared = prepareRequest(
      'https://api.example.com/x',
      { a: 1 },
      {
        method: 'GET',
        bodyAlways: true,
      },
    );
    expect(prepared.url).toBe('https://api.example.com/x');
    expect(prepared.body).toBe('{"a":1}');
  });

  it('encodes form bodies', () => {
    const prepared = prepareRequest('https://api.example.com/x', { a: 'b c' }, { form: true });
    expect(prepared.body).toBe('a=b+c');
    expect(prepared.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });
});

describe('inferMethod', () => {
  it('is GET with no data and POST with data', () => {
    expect(inferMethod(undefined)).toBe('GET');
    expect(inferMethod({ a: 1 })).toBe('POST');
    expect(inferMethod({ a: 1 }, 'get')).toBe('GET');
  });
});

describe('Engine.call', () => {
  it('returns a free response and logs amount 0', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { lei: 'X' }));
    const result = await makeEngine().call({ target: 'https://api.example.com/v1/lei' });
    expect(result.ok).toBe(true);
    expect(result.paid).toBe(false);
    expect(result.amount).toBe('0');
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.payment).toMatchObject({ paid: false, amount: '0' });
  });

  it('runs the whole payment loop and records a receipt', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(402, requirements())).mockResolvedValueOnce(
      jsonResponse(
        200,
        { lei: '213800XYZ' },
        {
          'x-payment-response': Buffer.from(
            JSON.stringify({ success: true, transaction: '0xdeadbeef' }),
          ).toString('base64'),
        },
      ),
    );

    const signer = new FakeSigner();
    const result = await makeEngine({}, signer).call({
      target: 'https://api.example.com/v1/lei',
      data: { query: 'Roundhouse AI Ltd.' },
      method: 'GET',
    });

    expect(result.ok).toBe(true);
    expect(result.paid).toBe(true);
    expect(result.amount).toBe('0.002');
    expect(result.receipt?.settlement).toMatchObject({ success: true, transaction: '0xdeadbeef' });

    // The paid retry carried a base64 X-PAYMENT header with our authorization.
    const paidCall = fetchMock.mock.calls[1]![1] as { headers: Record<string, string> };
    const payload = decodePaymentHeader(paidCall.headers['x-payment']!);
    expect(payload.scheme).toBe('exact');
    expect(payload.payload.authorization.to).toBe(PAY_TO);
    expect(payload.payload.authorization.value).toBe('2000');

    expect(signer.signed[0]!.domain.chainId).toBe(8453);
    expect(signer.signed[0]!.primaryType).toBe('TransferWithAuthorization');

    const record = readRecords()[0]!;
    expect(record.payment).toMatchObject({
      paid: true,
      amount: '0.002',
      asset: 'usdc',
      cacheHit: false,
    });
    expect(record.exitCode).toBe(ExitCode.OK);
  });

  it('reuses the cached authorization instead of signing twice', async () => {
    const signer = new FakeSigner();
    const engine = makeEngine({}, signer);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(402, requirements()))
      .mockRejectedValueOnce(new Error('socket hang up'));
    const first = await engine.call({ target: 'https://api.example.com/v1/lei' });
    expect(first.errorCode).toBe(ExitCode.PAID_NO_RESPONSE);
    expect(signer.signed).toHaveLength(1);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(402, requirements()))
      .mockResolvedValueOnce(jsonResponse(200, { lei: 'X' }));
    const second = await engine.call({ target: 'https://api.example.com/v1/lei' });
    expect(second.ok).toBe(true);
    expect(second.cacheHit).toBe(true);
    expect(signer.signed).toHaveLength(1);
  });

  it('signs afresh with noCache', async () => {
    const signer = new FakeSigner();
    const engine = makeEngine({}, signer);
    for (let i = 0; i < 2; i++) {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(402, requirements()))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
      await engine.call({ target: 'https://api.example.com/v1/lei', noCache: true });
    }
    expect(signer.signed).toHaveLength(2);
  });

  it('refuses a price over --max with exit 44 and never signs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(402, requirements('50000')));
    const signer = new FakeSigner();
    const result = await makeEngine({}, signer).call({
      target: 'https://api.example.com/v1/lei',
      max: '0.01',
    });
    expect(result.errorCode).toBe(ExitCode.OVER_MAX);
    expect(signer.signed).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readRecords()[0]!.exitCode).toBe(ExitCode.OVER_MAX);
  });

  it('enforces the payTo allowlist with exit 43', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(402, requirements()));
    const result = await makeEngine({
      allowlist: { payTo: ['0x0000000000000000000000000000000000000001'], domains: [] },
    }).call({ target: 'https://api.example.com/v1/lei' });
    expect(result.errorCode).toBe(ExitCode.ALLOWLIST_DENIED);
  });

  it('enforces the domain allowlist before anything else', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(402, requirements()));
    const result = await makeEngine({
      allowlist: { payTo: [], domains: ['*.trusted.example'] },
    }).call({ target: 'https://api.example.com/v1/lei' });
    expect(result.errorCode).toBe(ExitCode.ALLOWLIST_DENIED);
  });

  it('enforces the session budget with exit 45', async () => {
    const budget = new SessionBudget(1000n); // 0.001 USDC
    fetchMock.mockResolvedValueOnce(jsonResponse(402, requirements('2000')));
    const result = await makeEngine({}, new FakeSigner(), budget).call({
      target: 'https://api.example.com/v1/lei',
    });
    expect(result.errorCode).toBe(ExitCode.BUDGET_EXHAUSTED);
  });

  it('enforces the daily cap from the ledger', async () => {
    const engine = makeEngine({ limits: { dailyCap: '0.003' } });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(402, requirements('2000')))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    const first = await engine.call({ target: 'https://api.example.com/v1/a' });
    expect(first.paid).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse(402, requirements('2000')));
    const second = await engine.call({ target: 'https://api.example.com/v1/b' });
    expect(second.errorCode).toBe(ExitCode.BUDGET_EXHAUSTED);
  });

  it('reports insufficient balance as exit 46', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(402, requirements()));
    const result = await makeEngine({}, new FakeSigner({ balance: '0.0001' })).call({
      target: 'https://api.example.com/v1/lei',
    });
    expect(result.errorCode).toBe(ExitCode.INSUFFICIENT_BALANCE);
  });

  it('dry-run stops before signing and reports the price', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(402, requirements()));
    const signer = new FakeSigner();
    const result = await makeEngine({}, signer).call({
      target: 'https://api.example.com/v1/lei',
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.paid).toBe(false);
    expect(result.selected?.amount).toBe('0.002');
    expect(signer.signed).toHaveLength(0);
  });

  it('reports a non-x402 402 body as exit 40', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(402, { message: 'pay me somehow' }));
    const result = await makeEngine().call({ target: 'https://api.example.com/v1/lei' });
    expect(result.errorCode).toBe(ExitCode.INVALID_402);
  });

  it('surfaces an OWS policy denial as exit 42', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(402, requirements()));
    const { X402Error } = await import('../src/core/errors.js');
    const signer = new FakeSigner({
      fail: new X402Error(ExitCode.POLICY_DENIED, 'denied by policy'),
    });
    const result = await makeEngine({}, signer).call({ target: 'https://api.example.com/v1/lei' });
    expect(result.errorCode).toBe(ExitCode.POLICY_DENIED);
    expect(readRecords()[0]!.payment.paid).toBe(false);
  });

  it('treats a second 402 after paying as a rejected authorization', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(402, requirements()))
      .mockResolvedValueOnce(jsonResponse(402, { error: 'invalid_signature' }));
    const result = await makeEngine().call({ target: 'https://api.example.com/v1/lei' });
    expect(result.errorCode).toBe(ExitCode.INVALID_402);
    expect(result.paid).toBe(true);
    expect(result.error).toContain('invalid_signature');
  });

  it('writes the ledger 0600 and hashes payloads by default', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { secret: 'value' }));
    await makeEngine().call({
      target: 'https://api.example.com/v1/lei',
      data: { query: 'Roundhouse AI Ltd.' },
      method: 'POST',
    });
    const ledgerFile = join(home, 'ledger.jsonl');
    expect(existsSync(ledgerFile)).toBe(true);
    const line = readFileSync(ledgerFile, 'utf8');
    expect(line).not.toContain('Roundhouse AI Ltd.');
    expect(line).toContain('sha256:');
    const record = readRecords()[0]!;
    expect(record.request.dataKeys).toEqual(['query']);
    expect(record.request.data).toBeUndefined();
  });

  it('stores plaintext only at payload level full', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await makeEngine({
      telemetry: { payload: 'full', redactKeys: ['company.name'] } as never,
    }).call({
      target: 'https://api.example.com/v1/lei',
      data: { query: 'Roundhouse AI Ltd.', company: { name: 'Roundhouse AI Ltd.' } },
      method: 'POST',
    });
    const record = readRecords()[0]!;
    expect(record.request.data).toMatchObject({
      query: 'Roundhouse AI Ltd.',
      company: { name: '[redacted]' },
    });
  });
});

describe('Engine.probe', () => {
  it('never pays', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(402, requirements()));
    const signer = new FakeSigner();
    const probe = await makeEngine({}, signer).probe({ target: 'https://api.example.com/v1/lei' });
    expect(probe.status).toBe(402);
    expect(probe.selected?.amount).toBe('0.002');
    expect(signer.signed).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
