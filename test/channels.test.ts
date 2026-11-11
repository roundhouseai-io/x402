import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  utimesSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, mergeDeep, type X402Config } from '../src/core/config.js';
import { Engine } from '../src/core/engine.js';
import { ExitCode } from '../src/core/errors.js';
import { decodePaymentHeader, type TypedDataDocument } from '../src/core/eip3009.js';
import { readRecords } from '../src/core/ledger.js';
import { listChannels, lockChannel, readChannel } from '../src/core/channelstore.js';
import { buildX402Policy } from '../src/core/owspolicy.js';
import { BATCH_SETTLEMENT_ADDRESS } from '../src/core/channel.js';
import type { SignerBackend } from '../src/core/signer.js';

const PAYER = '0x1111111111111111111111111111111111111111';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const RECEIVER_AUTH = '0x3333333333333333333333333333333333333333';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const URL = 'https://ioi.example/v1/chat/completions';
const T0 = 1_794_400_000_000;

const quote = (scheme: string, extra: Record<string, unknown>, amount = '1000') => ({
  scheme,
  network: 'eip155:8453',
  amount,
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2', ...extra },
});

const batchAccept = (amount = '1000', extra: Record<string, unknown> = {}) =>
  quote('batch-settlement', { receiverAuthorizer: RECEIVER_AUTH, ...extra }, amount);

const holdAccept = (amount = '5000') =>
  quote(
    'auth-capture',
    {
      captureAuthorizer: '0x5555555555555555555555555555555555555555',
      feeRecipient: '0x6666666666666666666666666666666666666666',
      captureDeadline: 1794500000,
      refundDeadline: 1794600000,
      minFeeBps: 0,
      maxFeeBps: 100,
    },
    amount,
  );

const required = (...accepts: unknown[]) => ({
  x402Version: 2,
  error: 'Payment required',
  resource: { url: URL, mimeType: 'application/json' },
  accepts,
});

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
const quoted = (body: unknown) =>
  new Response('{}', {
    status: 402,
    headers: { 'content-type': 'application/json', 'payment-required': b64(body) },
  });
const receipt = (charged: string, cumulative: string) =>
  b64({
    success: true,
    transaction: '0xfeed',
    network: 'eip155:8453',
    extra: { chargedAmount: charged, channelState: { chargedCumulativeAmount: cumulative } },
  });
const ok = (headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const rpc = (balance: bigint, claimed: bigint) =>
  new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${word(balance)}${word(claimed)}` }),
    { status: 200 },
  );

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
  async signTypedData(doc: TypedDataDocument): Promise<string> {
    this.signed.push(doc);
    return `0x${'cd'.repeat(32)}${(this.signed.length - 1).toString(16).padStart(2, '0')}`;
  }
}

let home: string;
let clock: { t: number };
let appQueue: Array<() => Response | Promise<Response>>;
let rpcQueue: Array<() => Response>;
let fetchMock: ReturnType<typeof vi.fn>;
const calls = { app: 0, rpc: 0 };

const engineFor = (signer: SignerBackend, overrides: Partial<X402Config> = {}) =>
  new Engine({
    config: mergeDeep(DEFAULT_CONFIG, overrides),
    signer: async () => signer,
    walletName: signer.wallet,
    backendName: signer.backend,
    now: () => clock.t,
  });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-chan-'));
  process.env.X402_HOME = home;
  clock = { t: T0 };
  appQueue = [];
  rpcQueue = [];
  calls.app = 0;
  calls.rpc = 0;
  fetchMock = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes('mainnet.base.org')) {
      calls.rpc++;
      const next = rpcQueue.shift();
      if (!next) throw new Error('unexpected RPC call');
      return next();
    }
    calls.app++;
    const next = appQueue.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.X402_HOME;
  rmSync(home, { recursive: true, force: true });
});

const callOnce = (
  signer: FakeSigner,
  extra: Record<string, unknown> = {},
  cfg: Partial<X402Config> = {},
) =>
  engineFor(signer, cfg).call({
    target: URL,
    data: { model: 'm' },
    scheme: 'batch-settlement',
    ...extra,
  });

const sentPayload = (n: number) => {
  const init = fetchMock.mock.calls.filter((c) => !String(c[0]).includes('mainnet.base.org'))[
    n
  ]![1] as {
    headers: Record<string, string>;
  };
  return decodePaymentHeader(init.headers['payment-signature']!).payload as unknown as Record<
    string,
    any
  >;
};

describe('choosing a channel scheme', () => {
  it('never picks batch-settlement or auth-capture on its own, and says how to allow it', async () => {
    appQueue.push(() => quoted(required(batchAccept())));
    const signer = new FakeSigner();
    const res = await engineFor(signer).call({ target: URL, data: {} });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ExitCode.INVALID_402);
    expect(res.error).toMatch(/opt-in: pass --scheme batch-settlement/);
    expect(signer.signed).toHaveLength(0);
  });

  it('prefers upto over a channel scheme when both are offered and no scheme is named', async () => {
    const upto = quote('upto', {
      facilitatorAddress: '0x0000000000000000000000000000000000000001',
    });
    appQueue.push(
      () => quoted(required(batchAccept(), upto)),
      () => ok(),
    );
    const signer = new FakeSigner();
    const res = await engineFor(signer).call({ target: URL, data: {}, dryRun: true });
    expect(res.selected?.scheme).toBe('upto');
  });

  it('a v1 quote cannot carry a channel scheme', async () => {
    appQueue.push(
      () =>
        new Response('{}', {
          status: 402,
          headers: {
            'payment-required': b64({
              x402Version: 1,
              accepts: [{ ...batchAccept(), maxAmountRequired: '1000' }],
            }),
          },
        }),
    );
    const res = await callOnce(new FakeSigner());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no supported payment scheme/);
  });
});

describe('opening a channel and paying from it', () => {
  it('first call: deposits five requests, signs a deposit and a voucher, and remembers the channel', async () => {
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    const signer = new FakeSigner();
    const res = await callOnce(signer);

    expect(res.ok).toBe(true);
    expect(signer.signed.map((d) => d.primaryType)).toEqual([
      'ReceiveWithAuthorization',
      'Voucher',
    ]);
    const body = sentPayload(1);
    expect(body.type).toBe('deposit');
    expect(body.deposit.amount).toBe('5000');
    expect(body.voucher.maxClaimableAmount).toBe('1000');
    expect(body.channelConfig).toMatchObject({
      payer: PAYER,
      receiver: PAY_TO,
      receiverAuthorizer: RECEIVER_AUTH,
      token: USDC,
    });

    const rec = listChannels()[0]!;
    expect(rec).toMatchObject({ balance: '5000', charged: '600', signedMax: '1000' });
    expect(rec.pendingDeposit).toBeUndefined();
    // The deposit is what left the wallet. The ledger and the result say so.
    expect(res.amount).toBe('0.005');
    const ledger = readRecords();
    expect(ledger[0]!.payment).toMatchObject({
      amount: '0.005',
      paid: true,
      scheme: 'batch-settlement',
    });
    expect(ledger[0]!.payment.channel).toMatchObject({
      kind: 'deposit',
      deposit: '0.005',
      charged: '0.0006',
      balance: '0.005',
      confirmed: true,
    });
  });

  it('second call: a voucher only, no deposit, no RPC, nothing new counted as spent', async () => {
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    const signer = new FakeSigner();
    await callOnce(signer);
    signer.signed.length = 0;

    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('400', '1000') }),
    );
    const second = await callOnce(signer);

    expect(second.ok).toBe(true);
    expect(calls.rpc).toBe(1);
    expect(signer.signed.map((d) => d.primaryType)).toEqual(['Voucher']);
    const body = sentPayload(3);
    expect(body.type).toBe('voucher');
    expect(body.voucher.maxClaimableAmount).toBe('1600');
    expect(second.amount).toBe('0');
    const rec = listChannels()[0]!;
    expect(rec).toMatchObject({ balance: '5000', charged: '1000', signedMax: '1600' });
    expect(readRecords()[1]!.payment).toMatchObject({ amount: '0', paid: true });
    expect(readRecords()[1]!.payment.channel).toMatchObject({
      kind: 'voucher',
      charged: '0.0004',
      cumulative: '0.001',
    });
  });

  it('a voucher that was accepted is spent: the next identical request signs a new one, not a replay', async () => {
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    const signer = new FakeSigner();
    await callOnce(signer);
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('400', '1000') }),
    );
    const before = signer.signed.length;
    await callOnce(signer);
    expect(signer.signed.length).toBe(before + 1);
    const a = sentPayload(1).voucher.maxClaimableAmount;
    const b = sentPayload(3).voucher.maxClaimableAmount;
    expect(BigInt(b)).toBeGreaterThan(BigInt(a));
  });

  it('keeps the cumulative amount from ever decreasing or passing the balance across many calls', async () => {
    const signer = new FakeSigner();
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('1000', '1000') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    await callOnce(signer);
    let last = 1000n;
    for (let i = 2; i <= 9; i++) {
      const charged = 1000n * BigInt(i);
      appQueue.push(
        () => quoted(required(batchAccept())),
        () => ok({ 'payment-response': receipt('1000', charged.toString()) }),
      );
      await callOnce(signer);
      const rec = listChannels()[0]!;
      const idx =
        fetchMock.mock.calls.filter((c) => !String(c[0]).includes('mainnet.base.org')).length - 1;
      const sent = BigInt(sentPayload(idx).voucher.maxClaimableAmount);
      expect(sent).toBeGreaterThanOrEqual(last);
      expect(sent).toBeLessThanOrEqual(BigInt(rec.balance));
      expect(BigInt(rec.signedMax)).toBeGreaterThanOrEqual(sent);
      last = sent;
    }
    // Five requests were deposited and nine were paid: the channel was topped up on the way.
    expect(BigInt(listChannels()[0]!.balance)).toBeGreaterThan(5000n);
  });
});

describe('a dry run of a channel call', () => {
  it('says the call would move the deposit, not just the quote, and signs and reads nothing', async () => {
    appQueue.push(() => quoted(required(batchAccept())));
    const signer = new FakeSigner();
    const res = await callOnce(signer, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.amount).toBe('0.005');
    expect(res.warnings?.join(' ')).toMatch(/escrow/);
    expect(signer.signed).toHaveLength(0);
    expect(calls.rpc).toBe(0);
    expect(listChannels()).toHaveLength(0);
  });

  it('is gated like the real call', async () => {
    appQueue.push(() => quoted(required(batchAccept())));
    const res = await callOnce(new FakeSigner(), { dryRun: true, max: '0.0005' });
    expect(res.errorCode).toBe(ExitCode.OVER_MAX);
  });
});

describe('what the caps compare for a channel', () => {
  it('a deposit is gated on the deposit: --max below it refuses, signs nothing and makes no RPC call', async () => {
    appQueue.push(() => quoted(required(batchAccept())));
    const signer = new FakeSigner();
    const res = await callOnce(signer, { max: '0.0005' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ExitCode.OVER_MAX);
    expect(signer.signed).toHaveLength(0);
    expect(calls.rpc).toBe(0);
    expect(listChannels()).toHaveLength(0);
  });

  it('a default deposit is held to --max when the request itself fits: one request in escrow', async () => {
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    const signer = new FakeSigner();
    const res = await callOnce(signer, { max: '0.001' });
    expect(res.ok).toBe(true);
    expect(sentPayload(1).deposit.amount).toBe('1000');
  });

  it('the daily cap counts the deposit, so a channel cannot get past it', async () => {
    appQueue.push(() => quoted(required(batchAccept())));
    const signer = new FakeSigner();
    const res = await callOnce(signer, {}, { limits: { maxPerCall: '1.00', dailyCap: '0.004' } });
    expect(res.errorCode).toBe(ExitCode.BUDGET_EXHAUSTED);
    expect(signer.signed).toHaveLength(0);
  });

  it('once the deposit has used the day, vouchers still pay: they draw on money already counted', async () => {
    const cfg = { limits: { maxPerCall: '1.00', dailyCap: '0.005' } };
    const signer = new FakeSigner();
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    expect((await callOnce(signer, {}, cfg)).ok).toBe(true);

    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('400', '1000') }),
    );
    expect((await callOnce(signer, {}, cfg)).ok).toBe(true);
    // The cap is spent (0.005 of 0.005), and a voucher added nothing to it.
    const spent = readRecords().reduce(
      (n, r) => n + (r.payment.paid ? Number(r.payment.amount) : 0),
      0,
    );
    expect(spent).toBeCloseTo(0.005, 9);
  });

  it('a voucher is still held to --max by the size of the request it pays for', async () => {
    const signer = new FakeSigner();
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    await callOnce(signer);
    signer.signed.length = 0;
    appQueue.push(() => quoted(required(batchAccept('1000'))));
    const res = await callOnce(signer, { max: '0.0005' });
    expect(res.errorCode).toBe(ExitCode.OVER_MAX);
    expect(signer.signed).toHaveLength(0);
  });

  it('the payTo allowlist still applies to a channel', async () => {
    appQueue.push(() => quoted(required(batchAccept())));
    const signer = new FakeSigner();
    const res = await callOnce(
      signer,
      {},
      { allowlist: { payTo: ['0x9999999999999999999999999999999999999999'], domains: [] } },
    );
    expect(res.errorCode).toBe(ExitCode.ALLOWLIST_DENIED);
    expect(signer.signed).toHaveLength(0);
  });
});

describe('when money may have moved and nothing says so', () => {
  const lostDeposit = async (signer: FakeSigner) => {
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => {
        throw new Error('socket hang up');
      },
    );
    rpcQueue.push(() => rpc(0n, 0n));
    return callOnce(signer);
  };

  it('a deposit whose response was lost is counted as spent, and the channel marks it pending', async () => {
    const signer = new FakeSigner();
    const res = await lostDeposit(signer);
    expect(res.errorCode).toBe(ExitCode.PAID_NO_RESPONSE);
    expect(res.paid).toBe(true);
    expect(res.amount).toBe('0.005');
    const rec = listChannels()[0]!;
    expect(rec.pendingDeposit).toMatchObject({ amount: '5000' });
    expect(readRecords()[0]!.payment.amount).toBe('0.005');
  });

  it('replays the same deposit signature for the same request, so the worst case stays one deposit', async () => {
    const signer = new FakeSigner();
    await lostDeposit(signer);
    const signedBefore = signer.signed.length;
    clock.t = T0 + 60_000;
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    const res = await callOnce(signer);
    expect(res.ok).toBe(true);
    expect(res.cacheHit).toBe(true);
    expect(signer.signed.length).toBe(signedBefore);
    expect(sentPayload(1).deposit.authorization).toEqual(sentPayload(3).deposit.authorization);
    expect(listChannels()[0]).toMatchObject({ balance: '5000', charged: '600' });
    expect(listChannels()[0]!.pendingDeposit).toBeUndefined();
  });

  it('refuses a different request while the first deposit can still land, signing nothing', async () => {
    const signer = new FakeSigner();
    await lostDeposit(signer);
    const signedBefore = signer.signed.length;
    clock.t = T0 + 60_000;
    appQueue.push(() => quoted(required(batchAccept())));
    const res = await engineFor(signer).call({
      target: URL,
      data: { model: 'a-different-request' },
      scheme: 'batch-settlement',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/may still be submitted until/);
    expect(signer.signed.length).toBe(signedBefore);
  });

  it('after the window, reads the chain: a deposit that never landed is forgotten and a fresh one is made', async () => {
    const signer = new FakeSigner();
    await lostDeposit(signer);
    clock.t = T0 + 400_000;
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    const res = await callOnce(signer);
    expect(res.ok).toBe(true);
    expect(sentPayload(3).type).toBe('deposit');
  });

  it('after the window, a deposit that did land is adopted from the chain, and only a voucher is signed', async () => {
    const signer = new FakeSigner();
    await lostDeposit(signer);
    signer.signed.length = 0;
    clock.t = T0 + 400_000;
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    rpcQueue.push(() => rpc(5000n, 0n));
    const res = await callOnce(signer);
    expect(res.ok).toBe(true);
    expect(signer.signed.map((d) => d.primaryType)).toEqual(['Voucher']);
    expect(sentPayload(3).type).toBe('voucher');
  });

  it('fails closed when the chain cannot be read: nothing is signed', async () => {
    appQueue.push(() => quoted(required(batchAccept())));
    rpcQueue.push(() => new Response('upstream down', { status: 502 }));
    const signer = new FakeSigner();
    const res = await callOnce(signer);
    expect(res.ok).toBe(false);
    expect(signer.signed).toHaveLength(0);
  });

  it('a lost voucher response keeps the charge unknown and replays the same voucher on a retry', async () => {
    const signer = new FakeSigner();
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    await callOnce(signer);
    signer.signed.length = 0;

    appQueue.push(
      () => quoted(required(batchAccept())),
      () => {
        throw new Error('timeout');
      },
    );
    const lost = await callOnce(signer);
    expect(lost.errorCode).toBe(ExitCode.PAID_NO_RESPONSE);
    expect(lost.amount).toBe('0');
    expect(listChannels()[0]!.charged).toBe('600');
    expect(signer.signed).toHaveLength(1);

    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('400', '1000') }),
    );
    const retry = await callOnce(signer);
    expect(retry.ok).toBe(true);
    expect(signer.signed).toHaveLength(1);
    expect(retry.cacheHit).toBe(true);
  });
});

describe('a receiver that says the total is out of step', () => {
  const corrective = (cumulative: string) =>
    new Response('{}', {
      status: 402,
      headers: {
        'payment-required': b64({
          ...required(batchAccept()),
          error: 'invalid_batch_settlement_evm_cumulative_amount_mismatch',
          accepts: [batchAccept('1000', { channelState: { chargedCumulativeAmount: cumulative } })],
        }),
      },
    });

  const openChannel = async (signer: FakeSigner) => {
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    await callOnce(signer);
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('400', '1000') }),
    );
    await callOnce(signer);
    signer.signed.length = 0;
  };

  it('adopts a total inside what was signed, re-signs once, and succeeds', async () => {
    const signer = new FakeSigner();
    await openChannel(signer);
    // The channel believes 1000 is charged, so the next voucher names 2000. The
    // receiver says it is at 1900, which is between 1000 and 2000.
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => corrective('1900'),
      () => ok({ 'payment-response': receipt('500', '2400') }),
    );
    const res = await callOnce(signer);
    expect(res.ok).toBe(true);
    expect(signer.signed).toHaveLength(2);
    expect(listChannels()[0]!.charged).toBe('2400');
    const retried = sentPayload(calls.app - 1);
    expect(retried.voucher.maxClaimableAmount).toBe('2900');
  });

  it('refuses a total above anything ever signed, and stops: the receiver cannot be owed that', async () => {
    const signer = new FakeSigner();
    await openChannel(signer);
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => corrective('5000'),
    );
    const res = await callOnce(signer);
    expect(res.ok).toBe(false);
    expect(res.paymentState).toBe('signed');
    expect(res.paid).toBe(false);
    expect(signer.signed).toHaveLength(1);
    expect(listChannels()[0]!.charged).toBe('1000');
  });

  it('only retries once, however the receiver answers', async () => {
    const signer = new FakeSigner();
    await openChannel(signer);
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => corrective('1900'),
      () => corrective('1950'),
    );
    const res = await callOnce(signer);
    expect(res.ok).toBe(false);
    expect(signer.signed).toHaveLength(2);
    expect(appQueue).toHaveLength(0);
  });
});

describe('the channel store', () => {
  it('keeps its files 0600 in a 0700 directory', async () => {
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('600', '600') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    await callOnce(new FakeSigner());
    const dir = join(home, 'channels');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const file = join(dir, `${listChannels()[0]!.slot}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(JSON.parse(readFileSync(file, 'utf8')))).not.toMatch(/private|secret/i);
  });

  it('lets one call hold a channel at a time, and gives up when it cannot', async () => {
    const release = await lockChannel('slot-a');
    await expect(lockChannel('slot-a', 150)).rejects.toThrow(
      /another call is using this payment channel/,
    );
    release();
    const again = await lockChannel('slot-a', 150);
    again();
  });

  it('takes over a lock left by a process that died', async () => {
    const locks = join(home, 'channels', 'locks');
    mkdirSync(locks, { recursive: true });
    const stale = join(locks, 'slot-b.lock');
    writeFileSync(stale, '999999 long ago\n');
    const old = new Date(Date.now() - 30 * 60_000);
    utimesSync(stale, old, old);
    const release = await lockChannel('slot-b', 150);
    release();
    expect(existsSync(stale)).toBe(false);
  });

  it('releases the lock when a call fails, so the next one is not blocked', async () => {
    appQueue.push(() => quoted(required(batchAccept())));
    await callOnce(new FakeSigner(), { max: '0.0005' });
    const release = await lockChannel(listChannels()[0]?.slot ?? 'none', 150);
    release();
  });
});

describe('a quote that cannot be paid safely', () => {
  it('a quote with no receiverAuthorizer is refused before anything is signed or read from the chain', async () => {
    appQueue.push(() => quoted(required(quote('batch-settlement', {}))));
    const signer = new FakeSigner();
    const res = await callOnce(signer);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(ExitCode.INVALID_402);
    expect(signer.signed).toHaveLength(0);
    expect(calls.rpc).toBe(0);
  });
});

describe('auth-capture', () => {
  it('signs one authorization for the quoted maximum, and counts the whole hold as spent', async () => {
    appQueue.push(
      () => quoted(required(holdAccept())),
      () =>
        ok({ 'payment-response': b64({ success: true, transaction: '0xabc', amount: '1200' }) }),
    );
    const signer = new FakeSigner();
    const res = await engineFor(signer).call({ target: URL, data: {}, scheme: 'auth-capture' });
    expect(res.ok).toBe(true);
    expect(signer.signed.map((d) => d.primaryType)).toEqual(['ReceiveWithAuthorization']);
    const body = sentPayload(1);
    expect(body.authorization.value).toBe('5000');
    expect(body.authorization.from).toBe(PAYER);
    // The receipt names 1200, but a hold says nothing about what will be captured:
    // the whole maximum counts against the caps.
    expect(res.amount).toBe('0.005');
    expect(readRecords()[0]!.payment).toMatchObject({ amount: '0.005', scheme: 'auth-capture' });
  });

  it('is held to --max by the whole hold', async () => {
    appQueue.push(() => quoted(required(holdAccept())));
    const signer = new FakeSigner();
    const res = await engineFor(signer).call({
      target: URL,
      data: {},
      scheme: 'auth-capture',
      max: '0.004',
    });
    expect(res.errorCode).toBe(ExitCode.OVER_MAX);
    expect(signer.signed).toHaveLength(0);
  });

  it('refuses a quote that names an escrow it does not know, signing nothing', async () => {
    const hold = holdAccept();
    appQueue.push(() =>
      quoted(
        required({
          ...hold,
          extra: { ...hold.extra, authCaptureEscrow: '0x9999999999999999999999999999999999999999' },
        }),
      ),
    );
    const signer = new FakeSigner();
    const res = await engineFor(signer).call({ target: URL, data: {}, scheme: 'auth-capture' });
    expect(res.errorCode).toBe(ExitCode.INVALID_402);
    expect(signer.signed).toHaveLength(0);
  });

  it('a lost response still counts the hold as spent, and the retry reuses the signature', async () => {
    appQueue.push(
      () => quoted(required(holdAccept())),
      () => {
        throw new Error('reset');
      },
    );
    const signer = new FakeSigner();
    const lost = await engineFor(signer).call({ target: URL, data: {}, scheme: 'auth-capture' });
    expect(lost.errorCode).toBe(ExitCode.PAID_NO_RESPONSE);
    expect(lost.amount).toBe('0.005');
    appQueue.push(
      () => quoted(required(holdAccept())),
      () => ok(),
    );
    const retry = await engineFor(signer).call({ target: URL, data: {}, scheme: 'auth-capture' });
    expect(retry.ok).toBe(true);
    expect(signer.signed).toHaveLength(1);
  });
});

describe('refunding a channel', () => {
  const open = async (signer: FakeSigner) => {
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => ok({ 'payment-response': receipt('1000', '1000') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    await callOnce(signer);
    signer.signed.length = 0;
  };
  const refund = (signer: FakeSigner, amount?: string) =>
    engineFor(signer).refundChannel({ target: URL, amount, method: 'GET' });
  const accepted = () =>
    ok({
      'payment-response': b64({ success: true, transaction: '0xrefund', network: 'eip155:8453' }),
    });

  it('signs a voucher for what has been charged, asks for everything left, and forgets the channel', async () => {
    const signer = new FakeSigner();
    await open(signer);
    appQueue.push(() => quoted(required(batchAccept())), accepted);
    const res = await refund(signer);
    expect(res.ok).toBe(true);
    expect(signer.signed.map((d) => d.primaryType)).toEqual(['Voucher']);
    expect(signer.signed[0]!.message.maxClaimableAmount).toBe('1000');
    const body = sentPayload(3);
    expect(body.type).toBe('refund');
    expect(body.amount).toBeUndefined();
    expect(listChannels()).toHaveLength(0);
    const last = readRecords().at(-1)!;
    expect(last.payment).toMatchObject({ amount: '0', paid: false, state: 'settled' });
    expect(last.payment.channel).toMatchObject({ kind: 'refund', confirmed: true });
  });

  it('a partial refund lowers the balance and keeps the channel', async () => {
    const signer = new FakeSigner();
    await open(signer);
    appQueue.push(() => quoted(required(batchAccept())), accepted);
    const res = await refund(signer, '0.0015');
    expect(res.ok).toBe(true);
    expect(sentPayload(3).amount).toBe('1500');
    expect(listChannels()[0]).toMatchObject({ balance: '3500', charged: '1000' });
    expect(res.remaining).toBe('0.0025');
  });

  it('does nothing when there is no channel, and signs nothing', async () => {
    appQueue.push(() => quoted(required(batchAccept())));
    rpcQueue.push(() => rpc(0n, 0n));
    const signer = new FakeSigner();
    const res = await refund(signer);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing to refund/);
    expect(signer.signed).toHaveLength(0);
  });

  it('keeps the channel exactly as it was when the receiver refuses', async () => {
    const signer = new FakeSigner();
    await open(signer);
    const before = readChannel(listChannels()[0]!.slot);
    appQueue.push(
      () => quoted(required(batchAccept())),
      () => quoted(required(batchAccept())),
    );
    const res = await refund(signer);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/refund was not accepted/);
    expect({ ...readChannel(before!.slot), updatedAt: '' }).toEqual({ ...before, updatedAt: '' });
  });

  it('refuses when nothing is left to refund', async () => {
    const signer = new FakeSigner();
    appQueue.push(
      () => quoted(required(batchAccept('1000'))),
      () => ok({ 'payment-response': receipt('1000', '1000') }),
    );
    rpcQueue.push(() => rpc(0n, 0n));
    await callOnce(signer, { max: '0.001' }); // a one-request channel, fully charged
    signer.signed.length = 0;
    appQueue.push(() => quoted(required(batchAccept())));
    const res = await refund(signer);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no balance left/);
    expect(signer.signed).toHaveLength(0);
  });

  it('applies the domain allowlist to the refund URL', async () => {
    const signer = new FakeSigner();
    await open(signer);
    appQueue.push(() => quoted(required(batchAccept())));
    const res = await engineFor(signer, {
      allowlist: { payTo: [], domains: ['elsewhere.example'] },
    }).refundChannel({ target: URL });
    expect(res.errorCode).toBe(ExitCode.ALLOWLIST_DENIED);
    expect(signer.signed).toHaveLength(0);
  });
});

describe('the OWS policy', () => {
  const contracts = (opts: { allowChannels?: boolean; allowPermit2?: boolean }) => {
    const policy = buildX402Policy({
      id: 'p',
      name: 'n',
      chains: ['base'],
      now: new Date('2026-11-11T00:00:00Z'),
      ...opts,
    });
    const rule = policy.rules.find((r) => r.type === 'allowed_typed_data_contracts');
    return rule && 'contracts' in rule ? rule.contracts : [];
  };

  it('does not allow the channel escrow unless asked: it cannot be narrowed to one channel', () => {
    expect(contracts({})).not.toContain(BATCH_SETTLEMENT_ADDRESS);
  });

  it('allows it with allowChannels, and leaves Permit2 alone', () => {
    const c = contracts({ allowChannels: true });
    expect(c).toContain(BATCH_SETTLEMENT_ADDRESS);
    expect(c).not.toContain('0x000000000022D473030F116dDEE9F6B43aC78BA3');
  });
});
