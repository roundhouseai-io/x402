import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, mergeDeep } from '../src/core/config.js';
import { Engine } from '../src/core/engine.js';
import { ExitCode } from '../src/core/errors.js';
import { decodePaymentHeader, type TypedDataDocument } from '../src/core/eip3009.js';
import {
  PERMIT2_ADDRESS,
  UPTO_PERMIT2_PROXY,
  buildEip2612Permit,
  buildUptoPermit2,
} from '../src/core/permit2.js';
import { parsePaymentRequired, selectOption } from '../src/core/x402.js';
import { buildX402Policy } from '../src/core/owspolicy.js';
import type { SignerBackend } from '../src/core/signer.js';

const PAY_TO = '0x2222222222222222222222222222222222222222';
const FACILITATOR = '0x0000000000000000000000000000000000000001';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYER = '0x1111111111111111111111111111111111111111';

const uptoOption = (amount = '12345', extra: Record<string, unknown> = {}) => ({
  scheme: 'upto',
  network: 'eip155:8453',
  amount,
  asset: USDC_BASE,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2', facilitatorAddress: FACILITATOR, ...extra },
});

const exactOption = (amount = '3000') => ({
  scheme: 'exact',
  network: 'eip155:8453',
  amount,
  asset: USDC_BASE,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
});

const quote = (accepts: unknown[], extensions: Record<string, unknown> = {}) => ({
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://ioi.example/v1/chat/completions', mimeType: 'application/json' },
  accepts,
  extensions,
});

const header = (payload: unknown) => ({
  'payment-required': Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const rpcResult = (hex: string) => json(200, { jsonrpc: '2.0', id: 1, result: hex });
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

describe('upto Permit2 typed data', () => {
  // Values captured from the reference client (@x402/evm upto/client) for this
  // exact quote, with its nonce and deadline pinned here. If the reference
  // changes what it signs, this is the test that should say so.
  const option = parsePaymentRequired(quote([uptoOption()])).options[0]!;
  const nonce = '74092507446065423597704307413709368524572968711327247619311934180359830784066';

  it('signs what the reference client signs', () => {
    const built = buildUptoPermit2({ option, from: PAYER, now: 1794330416, nonce });
    expect(built.typedData.primaryType).toBe('PermitWitnessTransferFrom');
    expect(built.typedData.domain).toEqual({
      name: 'Permit2',
      chainId: 8453,
      verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    });
    expect(built.typedData.message).toEqual({
      permitted: { token: USDC_BASE, amount: '12345' },
      spender: '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002',
      nonce,
      deadline: '1794330716',
      witness: { to: PAY_TO, facilitator: FACILITATOR, validAfter: '0' },
    });
    expect(built.typedData.types.PermitWitnessTransferFrom!.map((f) => f.name)).toEqual([
      'permitted',
      'spender',
      'nonce',
      'deadline',
      'witness',
    ]);
    expect(built.typedData.types.Witness!.map((f) => f.name)).toEqual([
      'to',
      'facilitator',
      'validAfter',
    ]);
    // The Permit2 domain has no version, and the document must say so.
    expect(built.typedData.types.EIP712Domain!.map((f) => f.name)).toEqual([
      'name',
      'chainId',
      'verifyingContract',
    ]);
    expect(built.authorization).toEqual({ from: PAYER, ...built.typedData.message });
  });

  it('always names the upto proxy as spender, whatever the quote says', () => {
    const hostile = parsePaymentRequired(
      quote([uptoOption('12345', { spender: '0x9999999999999999999999999999999999999999' })]),
    ).options[0]!;
    const built = buildUptoPermit2({ option: hostile, from: PAYER });
    expect(built.authorization.spender).toBe(UPTO_PERMIT2_PROXY);
  });

  it('refuses a quote with no facilitatorAddress before signing', () => {
    const bare = parsePaymentRequired(
      quote([uptoOption('12345', { facilitatorAddress: undefined })]),
    ).options[0]!;
    expect(() => buildUptoPermit2({ option: bare, from: PAYER })).toThrow(/facilitatorAddress/);
  });

  it('builds an EIP-2612 permit for Permit2 over the token domain from the asset table', () => {
    const permit = buildEip2612Permit({ option, from: PAYER, nonce: 7n, deadline: '1794330716' });
    expect(permit.typedData.primaryType).toBe('Permit');
    expect(permit.typedData.domain).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: USDC_BASE,
    });
    expect(permit.typedData.message).toEqual({
      owner: PAYER,
      spender: PERMIT2_ADDRESS,
      value: '12345',
      nonce: '7',
      deadline: '1794330716',
    });
    expect(permit.info.version).toBe('1');
  });
});

describe('selecting a scheme', () => {
  const both = parsePaymentRequired(quote([exactOption('3000'), uptoOption('9000')]));

  it('prefers upto when both are offered, even though its ceiling is higher', () => {
    expect(selectOption(both).scheme).toBe('upto');
  });

  it('--scheme exact forces exact', () => {
    expect(selectOption(both, { scheme: 'exact' }).scheme).toBe('exact');
  });

  it('falls back to exact when only exact is offered', () => {
    const only = parsePaymentRequired(quote([exactOption()]));
    expect(selectOption(only).scheme).toBe('exact');
  });

  it('never picks upto from a v1 quote, which has no place to carry it', () => {
    const v1 = parsePaymentRequired({
      x402Version: 1,
      accepts: [
        {
          scheme: 'upto',
          network: 'base',
          maxAmountRequired: '9000',
          payTo: PAY_TO,
          asset: USDC_BASE,
          maxTimeoutSeconds: 60,
          extra: { name: 'USD Coin', version: '2', facilitatorAddress: FACILITATOR },
        },
      ],
    });
    expect(() => selectOption(v1)).toThrow(/no supported payment scheme/);
  });
});

describe('OWS policy and Permit2', () => {
  const now = new Date('2026-08-28T00:00:00Z');
  it('does not allow Permit2 unless asked, because it cannot be narrowed to a token', () => {
    const policy = buildX402Policy({ id: 'p', name: 'n', chains: ['base'], now });
    const rule = policy.rules.find((r) => r.type === 'allowed_typed_data_contracts');
    expect(rule && 'contracts' in rule && rule.contracts).not.toContain(PERMIT2_ADDRESS);
  });

  it('allows it with allowPermit2', () => {
    const policy = buildX402Policy({
      id: 'p',
      name: 'n',
      chains: ['base'],
      now,
      allowPermit2: true,
    });
    const rule = policy.rules.find((r) => r.type === 'allowed_typed_data_contracts');
    expect(rule && 'contracts' in rule && rule.contracts).toContain(PERMIT2_ADDRESS);
  });
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
    return `0x${'cd'.repeat(32)}${(this.signed.length - 1).toString(16).padStart(2, '0')}`;
  }
}

let home: string;
let fetchMock: ReturnType<typeof vi.fn>;

const engineFor = (signer: SignerBackend) =>
  new Engine({
    config: mergeDeep(DEFAULT_CONFIG, { limits: { maxPerCall: '1.00' } }),
    signer: async () => signer,
    walletName: signer.wallet,
    backendName: signer.backend,
    now: () => 1_700_000_000_000,
  });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-upto-'));
  process.env.X402_HOME = home;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.X402_HOME;
  rmSync(home, { recursive: true, force: true });
});

const sponsoring = { eip2612GasSponsoring: { info: { description: 'sponsored permit' } } };

describe('paying an upto quote', () => {
  it('signs a Permit2 transfer plus an EIP-2612 permit for a wallet with no allowance', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(402, {}, header(quote([uptoOption(), exactOption()], sponsoring))),
      )
      .mockResolvedValueOnce(rpcResult(word(0n))) // allowance(owner, Permit2)
      .mockResolvedValueOnce(rpcResult(word(5n))) // nonces(owner)
      .mockResolvedValueOnce(json(200, { ok: true }));

    const signer = new FakeSigner();
    const result = await engineFor(signer).call({
      target: 'https://ioi.example/v1/chat/completions',
      data: { model: 'm' },
    });

    expect(result.ok).toBe(true);
    expect(signer.signed.map((d) => d.primaryType)).toEqual([
      'PermitWitnessTransferFrom',
      'Permit',
    ]);
    expect(signer.signed[1]!.message.nonce).toBe('5');

    const paid = fetchMock.mock.calls[3]![1] as { headers: Record<string, string> };
    const payload = decodePaymentHeader(paid.headers['payment-signature']!);
    expect(payload).toMatchObject({
      x402Version: 2,
      accepted: { scheme: 'upto', amount: '12345', payTo: PAY_TO },
      payload: {
        permit2Authorization: {
          from: PAYER,
          permitted: { token: USDC_BASE, amount: '12345' },
          spender: UPTO_PERMIT2_PROXY,
          witness: { to: PAY_TO, facilitator: FACILITATOR },
        },
      },
    });
    const ext = (payload as { extensions: Record<string, { info: Record<string, string> }> })
      .extensions.eip2612GasSponsoring!.info;
    expect(ext).toMatchObject({
      from: PAYER,
      spender: PERMIT2_ADDRESS,
      amount: '12345',
      nonce: '5',
    });
    expect(ext.signature).toMatch(/^0xcdcd/);
  });

  it('skips the permit when Permit2 already has enough allowance', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([uptoOption()], sponsoring))))
      .mockResolvedValueOnce(rpcResult(word(10n ** 12n)))
      .mockResolvedValueOnce(json(200, { ok: true }));

    const signer = new FakeSigner();
    const result = await engineFor(signer).call({
      target: 'https://ioi.example/v1/chat/completions',
      data: { model: 'm' },
    });
    expect(result.ok).toBe(true);
    expect(signer.signed.map((d) => d.primaryType)).toEqual(['PermitWitnessTransferFrom']);
  });

  it('makes no RPC call when the quote does not declare gas sponsoring', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([uptoOption()]))))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const signer = new FakeSigner();
    await engineFor(signer).call({ target: 'https://ioi.example/v1/chat/completions', data: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signer.signed).toHaveLength(1);
  });

  it('signs nothing when the permit nonce cannot be read', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([uptoOption()], sponsoring))))
      .mockResolvedValueOnce(rpcResult(word(0n)))
      .mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const signer = new FakeSigner();
    const result = await engineFor(signer).call({
      target: 'https://ioi.example/v1/chat/completions',
      data: {},
    });
    expect(result.ok).toBe(false);
    expect(result.paid).toBe(false);
    // The Permit2 signature exists in memory, but nothing was sent.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refuses an upto quote with no facilitatorAddress and signs nothing', async () => {
    fetchMock.mockResolvedValueOnce(
      json(402, {}, header(quote([uptoOption('12345', { facilitatorAddress: undefined })]))),
    );
    const signer = new FakeSigner();
    const result = await engineFor(signer).call({
      target: 'https://ioi.example/v1/chat/completions',
      data: {},
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(ExitCode.INVALID_402);
    expect(signer.signed).toHaveLength(0);
  });

  it('pays the exact option when forced with scheme: exact', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, {}, header(quote([uptoOption(), exactOption()]))))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const signer = new FakeSigner();
    await engineFor(signer).call({
      target: 'https://ioi.example/v1/chat/completions',
      data: {},
      scheme: 'exact',
    });
    expect(signer.signed.map((d) => d.primaryType)).toEqual(['TransferWithAuthorization']);
  });
});
