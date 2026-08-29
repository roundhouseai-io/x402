import { describe, it, expect } from 'vitest';
import { parsePaymentRequired, requirementsFromHeaders, selectOption } from '../src/core/x402.js';
import { formatUnits, parseUnits } from '../src/core/assets.js';
import { X402Error, ExitCode } from '../src/core/errors.js';

const canonical = {
  x402Version: 1,
  error: 'payment required',
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '2000',
      resource: 'https://example.com/v1/lei',
      description: 'LEI lookup',
      mimeType: 'application/json',
      payTo: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd',
      maxTimeoutSeconds: 60,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};

describe('parsePaymentRequired', () => {
  it('parses the canonical envelope', () => {
    const parsed = parsePaymentRequired(canonical);
    expect(parsed.options).toHaveLength(1);
    const [option] = parsed.options;
    expect(option!.amount).toBe('0.002');
    expect(option!.amountAtomic).toBe(2000n);
    expect(option!.chain).toBe('eip155:8453');
    expect(option!.assetSymbol).toBe('usdc');
    expect(option!.eip712).toEqual({ name: 'USD Coin', version: '2' });
  });

  it('accepts a bare requirements object', () => {
    const parsed = parsePaymentRequired(canonical.accepts[0]);
    expect(parsed.options[0]!.amount).toBe('0.002');
  });

  it('accepts a bare array', () => {
    const parsed = parsePaymentRequired(canonical.accepts);
    expect(parsed.options).toHaveLength(1);
  });

  it('tolerates provider naming drift', () => {
    const parsed = parsePaymentRequired({
      requirements: [
        {
          type: 'exact',
          chainId: 8453,
          price: '0.01',
          recipient: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd',
          token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        },
      ],
    });
    expect(parsed.options[0]!.amount).toBe('0.01');
    expect(parsed.options[0]!.amountAtomic).toBe(10_000n);
  });

  it('rejects a payload with no usable option as exit 40', () => {
    try {
      parsePaymentRequired({ accepts: [{ scheme: 'exact', network: 'solana', amount: '1' }] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(X402Error);
      expect((err as X402Error).code).toBe(ExitCode.INVALID_402);
    }
  });

  it('rejects a malformed payTo', () => {
    expect(() =>
      parsePaymentRequired({
        accepts: [{ network: 'base', amount: '1', payTo: 'not-an-address' }],
      }),
    ).toThrow(/no usable payment option/);
  });
});

describe('selectOption', () => {
  const multi = parsePaymentRequired({
    accepts: [
      {
        scheme: 'exact',
        network: 'base-sepolia',
        maxAmountRequired: '500',
        payTo: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '3000',
        payTo: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '1000',
        payTo: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
    ],
  });

  it('prefers the configured chain, then the cheapest on it', () => {
    const chosen = selectOption(multi, { preferChain: 'base' });
    expect(chosen.network).toBe('base');
    expect(chosen.amountAtomic).toBe(1000n);
  });

  it('honours an explicit chain restriction', () => {
    const chosen = selectOption(multi, { chains: ['base-sepolia'], preferChain: 'base' });
    expect(chosen.network).toBe('base-sepolia');
  });

  it('fails when no option is on an allowed chain', () => {
    expect(() => selectOption(multi, { chains: ['unknown-chain'] })).toThrow();
  });

  it('rejects unsupported schemes', () => {
    const upto = parsePaymentRequired({
      accepts: [
        {
          scheme: 'upto',
          network: 'base',
          amount: '10',
          payTo: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        },
      ],
    });
    expect(() => selectOption(upto)).toThrow(/no supported payment scheme/);
  });
});

describe('amount conversion', () => {
  it('round-trips', () => {
    expect(formatUnits(2000n, 6)).toBe('0.002');
    expect(formatUnits(1_000_000n, 6)).toBe('1');
    expect(parseUnits('0.002', 6)).toBe(2000n);
    expect(parseUnits('5', 6)).toBe(5_000_000n);
  });

  it('refuses more precision than the asset has', () => {
    expect(() => parseUnits('0.0000001', 6)).toThrow();
  });
});

describe('requirementsFromHeaders (x402 v2)', () => {
  const V2 = {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '11000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0xe9030014F5DAe217d0A152f02A043567b16c1aBf',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  };
  const b64 = Buffer.from(JSON.stringify(V2), 'utf8').toString('base64');

  it('decodes the Payment-Required header', () => {
    const payload = requirementsFromHeaders({ 'payment-required': b64 });
    const required = parsePaymentRequired(payload);
    expect(required.x402Version).toBe(2);
    expect(required.options[0]?.amount).toBe('0.011');
    expect(required.options[0]?.payTo).toBe('0xe9030014F5DAe217d0A152f02A043567b16c1aBf');
  });

  it('decodes the WWW-Authenticate challenge form, quoted or bare', () => {
    for (const value of [`X402 requirements="${b64}"`, `x402 requirements=${b64}`]) {
      const required = parsePaymentRequired(requirementsFromHeaders({ 'www-authenticate': value }));
      expect(required.options[0]?.amountAtomic).toBe(11000n);
    }
  });

  it('returns undefined when no header carries a payload, leaving the body to answer', () => {
    expect(requirementsFromHeaders({})).toBeUndefined();
    expect(requirementsFromHeaders({ 'www-authenticate': 'Bearer realm="x"' })).toBeUndefined();
    expect(requirementsFromHeaders({ 'payment-required': 'not-base64-json!!' })).toBeUndefined();
  });

  it('prefers the header, whose price is the binding one', () => {
    // BlockRun.AI really does serve a body saying 0.01 beside a header saying 0.011.
    const body = { error: 'Payment Required', paymentInfo: { price: 0.01, network: 'base' } };
    const headers = { 'payment-required': b64 };

    const fromHeader = parsePaymentRequired(requirementsFromHeaders(headers) ?? body);

    expect(fromHeader.options[0]?.amount).toBe('0.011');
    // The body alone is not a usable payload at all — it carries no network.
    expect(() => parsePaymentRequired(body)).toThrow(/network/);
  });
});

describe('what a 402 is allowed to tell the CLI about the token', () => {
  const withAsset = (over: Record<string, unknown>) => ({
    ...canonical.accepts[0],
    ...over,
  });

  it('refuses a token contract it does not know on that chain', () => {
    // Not a compatibility gap to shim: an unknown contract's decimals and
    // EIP-712 domain would have to come from the counterparty, and the price
    // gate is computed from the decimals.
    try {
      parsePaymentRequired(withAsset({ asset: '0xdeAdbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF' }));
      throw new Error('should have thrown');
    } catch (err) {
      // SAFETY: the line above proves this threw; the reads below fail the test
      // if it was not an X402Error, which is the assertion.
      expect((err as X402Error).code).toBe(ExitCode.INVALID_402);
      expect((err as Error).message).toMatch(/is not a token this CLI knows on base/);
      expect((err as Error).message).toContain('usdc');
    }
  });

  it('refuses a payload that declares decimals the token does not have', () => {
    // The attack this closes. `--max` is compared in atomic units scaled by
    // these decimals, so a provider quoting 6-decimal USDC while declaring 18
    // gets a cap 10^12 too large: `--max 0.05` would wave through a demand for
    // fifty billion USDC while the gate reported that it held.
    expect(() => parsePaymentRequired(withAsset({ extra: { decimals: 18 } }))).toThrow(
      /declares 18 decimals for usdc, which has 6/,
    );
    expect(() =>
      parsePaymentRequired(
        withAsset({ maxAmountRequired: '50000000000000000', extra: { decimals: 18 } }),
      ),
    ).toThrow(/Refusing rather than pricing the call/);
  });

  it('accepts a payload whose declared decimals agree with the table', () => {
    const [option] = parsePaymentRequired(withAsset({ extra: { decimals: 6 } })).options;
    expect(option!.decimals).toBe(6);
    expect(option!.amount).toBe('0.002');
  });

  it('takes the EIP-712 domain from the table, not from the seller', () => {
    // `extra` is the provider describing a contract it does not own. The table
    // values were read from the contract.
    const [option] = parsePaymentRequired(
      withAsset({ extra: { name: 'Not USD Coin', version: '9' } }),
    ).options;
    expect(option!.eip712).toEqual({ name: 'USD Coin', version: '2' });
  });

  it('still says "missing asset" when there is no asset at all', () => {
    const bare = { ...canonical.accepts[0] } as Record<string, unknown>;
    delete bare.asset;
    expect(() => parsePaymentRequired(bare)).toThrow(/missing asset address/);
  });
});
