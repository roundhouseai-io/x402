import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BATCH_SETTLEMENT_ADDRESS,
  CUMULATIVE_MISMATCH,
  DEPOSIT_MULTIPLIER,
  afterRefund,
  announcedMinDeposit,
  applyCharge,
  buildChannelConfig,
  chargeReport,
  computeChannelId,
  correctiveCharged,
  depositMethodOf,
  eip3009DepositDocument,
  permit2DepositDocument,
  planChannelPayment,
  repairFromCorrective,
  voucherDocument,
  type ChannelState,
} from '../src/core/channel.js';
import { parsePaymentRequired, type PaymentOption } from '../src/core/x402.js';
import { ExitCode, X402Error } from '../src/core/errors.js';

// Everything in the fixture comes from running the reference clients in
// @x402/evm 2.30.0 (batch-settlement/client) with time and randomness pinned.
interface Signed {
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}
const vectors = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'channel-vectors.json'), 'utf8'),
) as {
  nowSeconds: number;
  batchDeposit: {
    requirements: Record<string, unknown>;
    result: { payload: Record<string, any> };
    signed: Signed[];
  };
  batchVoucher: { result: { payload: Record<string, any> }; signed: Signed[]; channelId: string };
  batchPermit2Deposit: {
    requirements: Record<string, unknown>;
    result: { payload: Record<string, any> };
    signed: Signed[];
  };
};

const PAYER = '0x1111111111111111111111111111111111111111';
const optionOf = (req: Record<string, unknown>): PaymentOption =>
  parsePaymentRequired({ x402Version: 2, accepts: [req] }).options[0]!;

describe('channel id and documents match the reference client', () => {
  const option = optionOf(vectors.batchDeposit.requirements);
  const config = buildChannelConfig(option, PAYER);

  it('builds the same channel configuration', () => {
    expect(config).toEqual(vectors.batchDeposit.result.payload.channelConfig);
  });

  it('computes the same channel id', () => {
    expect(computeChannelId(config, 8453)).toBe(
      vectors.batchDeposit.result.payload.voucher.channelId,
    );
  });

  it('the channel id depends on the chain, the receiver and the payer', () => {
    const id = computeChannelId(config, 8453);
    expect(computeChannelId(config, 84532)).not.toBe(id);
    expect(
      computeChannelId({ ...config, receiver: '0x9999999999999999999999999999999999999999' }, 8453),
    ).not.toBe(id);
    expect(
      computeChannelId(
        { ...config, payer: '0x9999999999999999999999999999999999999999', payerAuthorizer: PAYER },
        8453,
      ),
    ).not.toBe(id);
  });

  it('signs the same voucher, under the escrow domain', () => {
    const id = vectors.batchDeposit.result.payload.voucher.channelId as string;
    const doc = voucherDocument(id, 1000n, 8453);
    const ref = vectors.batchDeposit.signed[1]!;
    expect(doc.primaryType).toBe('Voucher');
    expect(doc.domain).toEqual(ref.domain);
    expect(doc.message).toEqual(ref.message);
    expect(doc.domain.verifyingContract).toBe(BATCH_SETTLEMENT_ADDRESS);
    // A second voucher in the same channel, as the reference signs it.
    expect(voucherDocument(id, 2000n, 8453).message).toEqual(
      vectors.batchVoucher.signed[0]!.message,
    );
  });

  it('builds the same ERC-3009 deposit authorization', () => {
    const id = computeChannelId(config, 8453);
    const salt = vectors.batchDeposit.result.payload.deposit.authorization.erc3009Authorization
      .salt as string;
    const built = eip3009DepositDocument({
      option,
      payer: PAYER,
      config,
      channelId: id,
      amount: 5000n,
      now: vectors.nowSeconds,
      salt,
    });
    const ref = vectors.batchDeposit.signed[0]!;
    expect(built.document.primaryType).toBe('ReceiveWithAuthorization');
    expect(built.document.domain).toEqual(ref.domain);
    expect(built.document.message).toEqual(ref.message);
    expect(built.validBefore).toBe(Number(ref.message.validBefore));
  });

  it('builds the same Permit2 deposit authorization, naming the channel', () => {
    const p2 = optionOf(vectors.batchPermit2Deposit.requirements);
    expect(depositMethodOf(p2)).toBe('permit2');
    const cfg = buildChannelConfig(p2, PAYER);
    const id = computeChannelId(cfg, 8453);
    const ref = vectors.batchPermit2Deposit.signed[0]!;
    const built = permit2DepositDocument({
      option: p2,
      payer: PAYER,
      config: cfg,
      channelId: id,
      amount: 5000n,
      now: vectors.nowSeconds,
      permit2Nonce: ref.message.nonce as string,
    });
    expect(built.document.primaryType).toBe('PermitWitnessTransferFrom');
    expect(built.document.domain).toEqual(ref.domain);
    expect(built.document.message).toEqual(ref.message);
  });
});

describe('what a quote has to carry', () => {
  const base = vectors.batchDeposit.requirements as { extra: Record<string, unknown> };

  it('refuses a quote with no receiverAuthorizer, before anything is signed', () => {
    const opt = optionOf({ ...base, extra: { ...base.extra, receiverAuthorizer: undefined } });
    expect(() => buildChannelConfig(opt, PAYER)).toThrow(X402Error);
    try {
      buildChannelConfig(opt, PAYER);
    } catch (e) {
      expect((e as X402Error).code).toBe(ExitCode.INVALID_402);
    }
  });

  it('refuses a zero receiverAuthorizer', () => {
    const opt = optionOf({
      ...base,
      extra: { ...base.extra, receiverAuthorizer: '0x0000000000000000000000000000000000000000' },
    });
    expect(() => buildChannelConfig(opt, PAYER)).toThrow(/receiverAuthorizer/);
  });

  it('refuses an asset transfer method it does not know', () => {
    const opt = optionOf({
      ...base,
      extra: { ...base.extra, assetTransferMethod: 'carrier-pigeon' },
    });
    expect(() => depositMethodOf(opt)).toThrow(/unsupported/);
  });

  it('packs a facilitator-managed refund authorizer into the low 20 bytes of the salt', () => {
    const refundAuthorizer = '0x4242424242424242424242424242424242424242';
    const opt = optionOf({
      ...base,
      extra: { ...base.extra, voucherManager: 'facilitator', refundAuthorizer },
    });
    const cfg = buildChannelConfig(opt, PAYER);
    expect(cfg.salt).toBe(`0x${'00'.repeat(12)}${refundAuthorizer.slice(2)}`);
    expect(computeChannelId(cfg, 8453)).not.toBe(
      vectors.batchDeposit.result.payload.voucher.channelId,
    );
  });

  it('uses the announced withdraw delay, else the 900 second minimum', () => {
    expect(buildChannelConfig(optionOf(base as never), PAYER).withdrawDelay).toBe(900);
    const slow = optionOf({ ...base, extra: { ...base.extra, withdrawDelay: 86400 } });
    expect(buildChannelConfig(slow, PAYER).withdrawDelay).toBe(86400);
  });
});

describe('planning a channel call', () => {
  const option = optionOf(vectors.batchDeposit.requirements); // 1000 atomic per request
  const state = (balance: string, charged: string, signedMax = charged): ChannelState => ({
    balance,
    charged,
    signedMax,
  });

  it('opens a channel with a deposit of five requests when there is none', () => {
    const plan = planChannelPayment({ option, state: undefined });
    expect(plan).toMatchObject({
      kind: 'deposit',
      deposit: 5000n,
      maxClaimable: 1000n,
      perCallAtomic: 5000n,
      exposureAtomic: 5000n,
    });
    expect(DEPOSIT_MULTIPLIER).toBe(5n);
  });

  it('pays a voucher from the balance, and a voucher adds no new exposure', () => {
    const plan = planChannelPayment({ option, state: state('5000', '600') });
    expect(plan).toEqual({
      kind: 'voucher',
      maxClaimable: 1600n,
      perCallAtomic: 1000n,
      exposureAtomic: 0n,
    });
  });

  it('never signs a voucher above the balance: it deposits first', () => {
    const plan = planChannelPayment({ option, state: state('5000', '4600') });
    expect(plan.kind).toBe('deposit');
    // Needs 600 more to cover 5600; the default tops up to five requests.
    expect(plan).toMatchObject({ deposit: 5000n, maxClaimable: 5600n });
  });

  it('a voucher exactly at the balance is allowed', () => {
    expect(planChannelPayment({ option, state: state('5000', '4000') }).kind).toBe('voucher');
  });

  it('treats an empty channel as needing a deposit', () => {
    expect(planChannelPayment({ option, state: state('0', '0') }).kind).toBe('deposit');
  });

  it('follows an announced minimum deposit that covers the request', () => {
    const announced = optionOf({
      ...vectors.batchDeposit.requirements,
      extra: { ...(vectors.batchDeposit.requirements.extra as object), minDeposit: '20000' },
    });
    expect(announcedMinDeposit(announced)).toBe(20000n);
    expect(planChannelPayment({ option: announced, state: undefined })).toMatchObject({
      deposit: 20000n,
    });
  });

  it('ignores an announced minimum below the request or not a number', () => {
    for (const bad of ['500', 'lots', '0']) {
      const o = optionOf({
        ...vectors.batchDeposit.requirements,
        extra: { ...(vectors.batchDeposit.requirements.extra as object), minDeposit: bad },
      });
      expect(announcedMinDeposit(o)).toBeUndefined();
    }
  });

  it('keeps a default deposit within the per-call cap when the request itself fits', () => {
    const plan = planChannelPayment({ option, state: undefined, capAtomic: 2000n });
    expect(plan).toMatchObject({ kind: 'deposit', deposit: 2000n, perCallAtomic: 2000n });
  });

  it('does not hide a request the cap cannot cover: the deposit stays above the cap so the gate refuses it', () => {
    const plan = planChannelPayment({ option, state: undefined, capAtomic: 500n });
    expect(plan).toMatchObject({ kind: 'deposit', deposit: 5000n });
  });

  it('uses --deposit exactly, and refuses one below what the request needs', () => {
    expect(planChannelPayment({ option, state: undefined, depositFlag: 3000n })).toMatchObject({
      deposit: 3000n,
    });
    expect(() => planChannelPayment({ option, state: undefined, depositFlag: 999n })).toThrow(
      /below/,
    );
  });

  it('an explicit --deposit is not clamped to the cap, so the cap can refuse it', () => {
    expect(
      planChannelPayment({ option, state: undefined, depositFlag: 9000n, capAtomic: 2000n }),
    ).toMatchObject({
      deposit: 9000n,
    });
  });
});

describe('believing what the receiver reports', () => {
  const prev: ChannelState = { balance: '5000', charged: '600', signedMax: '1600' };

  it('reads the charge and the cumulative total from a settle receipt', () => {
    expect(
      chargeReport({
        success: true,
        extra: { chargedAmount: '400', channelState: { chargedCumulativeAmount: '1000' } },
      }),
    ).toEqual({ charged: 400n, cumulative: 1000n });
    expect(chargeReport(undefined)).toEqual({ charged: undefined, cumulative: undefined });
    expect(chargeReport({ extra: { chargedAmount: 'lots' } }).charged).toBeUndefined();
  });

  it('adds the charge to the running total', () => {
    const next = applyCharge(prev, { charged: 400n, cumulative: 1000n }, 1000n, undefined, 1600n);
    expect(next).toEqual({ balance: '5000', charged: '1000', signedMax: '1600' });
  });

  it('adds a deposit to the balance', () => {
    const next = applyCharge(undefined, { charged: 600n, cumulative: 600n }, 1000n, 5000n, 1000n);
    expect(next).toEqual({ balance: '5000', charged: '600', signedMax: '1000' });
  });

  it('refuses a charge above the request, and leaves the state alone', () => {
    expect(() =>
      applyCharge(prev, { charged: 1001n, cumulative: undefined }, 1000n, undefined, 1600n),
    ).toThrow(/more than the request/);
  });

  it('keeps the local total when the receiver reports a different one', () => {
    const next = applyCharge(prev, { charged: 400n, cumulative: 9999n }, 1000n, undefined, 1600n);
    expect(next.charged).toBe('600');
  });

  it('never lowers the highest voucher signed', () => {
    const next = applyCharge(prev, { charged: 0n, cumulative: undefined }, 1000n, undefined, 100n);
    expect(next.signedMax).toBe('1600');
  });

  it('a charge of zero (the receiver took nothing) leaves the total where it was', () => {
    expect(
      applyCharge(prev, { charged: undefined, cumulative: undefined }, 1000n, undefined, 1600n)
        .charged,
    ).toBe('600');
  });
});

describe('repairing a channel that is one voucher behind', () => {
  const prev: ChannelState = { balance: '5000', charged: '1000', signedMax: '2000' };

  it('adopts a total between what is known and what was signed', () => {
    expect(repairFromCorrective(prev, 1900n)).toEqual({ ...prev, charged: '1900' });
  });

  it('refuses a total below what is already known (the receiver cannot un-charge)', () => {
    expect(repairFromCorrective(prev, 999n)).toBeUndefined();
  });

  it('refuses a total above the highest voucher ever signed: the receiver cannot have been given more', () => {
    expect(repairFromCorrective(prev, 2001n)).toBeUndefined();
  });

  it('reads the total out of a corrective payment-required body', () => {
    const accepts = [
      { scheme: 'exact' },
      { scheme: 'batch-settlement', extra: { channelState: { chargedCumulativeAmount: '1900' } } },
    ];
    expect(correctiveCharged(accepts)).toBe(1900n);
    expect(correctiveCharged([{ scheme: 'batch-settlement', extra: {} }])).toBeUndefined();
    expect(correctiveCharged('nope')).toBeUndefined();
    expect(CUMULATIVE_MISMATCH).toMatch(/cumulative_amount_mismatch$/);
  });
});

describe('after a refund', () => {
  const prev: ChannelState = { balance: '5000', charged: '1000', signedMax: '1000' };
  it('a refund of everything ends the channel', () => {
    expect(afterRefund(prev, undefined)).toBeUndefined();
  });
  it('a refund of at least what is left ends it too', () => {
    expect(afterRefund(prev, 4000n)).toBeUndefined();
    expect(afterRefund(prev, 9000n)).toBeUndefined();
  });
  it('a partial refund lowers the balance', () => {
    expect(afterRefund(prev, 1500n)).toEqual({ ...prev, balance: '3500' });
  });
});
