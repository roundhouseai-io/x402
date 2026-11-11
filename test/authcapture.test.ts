import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DEPLOYMENT_V1_0,
  DEPLOYMENT_V1_1,
  buildAuthCapture,
  deriveBoundSalt,
  resolveDeployment,
} from '../src/core/authcapture.js';
import { parsePaymentRequired } from '../src/core/x402.js';
import { ExitCode, X402Error } from '../src/core/errors.js';

interface Case {
  requirements: Record<string, unknown>;
  result: { payload: Record<string, any> };
  signed: Array<{
    primaryType: string;
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
  }>;
}
const vectors = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'channel-vectors.json'), 'utf8'),
) as {
  nowSeconds: number;
  authCapture3009: Case;
  authCapturePermit2: Case;
  authCaptureBound: Case;
};

const PAYER = '0x1111111111111111111111111111111111111111';
const optionOf = (req: Record<string, unknown>) =>
  parsePaymentRequired({ x402Version: 2, accepts: [req] }).options[0]!;

describe('auth-capture matches the reference client', () => {
  it('signs the same ERC-3009 authorization, and builds the same payload', () => {
    const c = vectors.authCapture3009;
    const built = buildAuthCapture({
      option: optionOf(c.requirements),
      payer: PAYER,
      now: vectors.nowSeconds,
      random: c.result.payload.salt,
    });
    expect(built.method).toBe('eip3009');
    expect(built.document.primaryType).toBe('ReceiveWithAuthorization');
    expect(built.document.domain).toEqual(c.signed[0]!.domain);
    expect(built.document.message).toEqual(c.signed[0]!.message);
    expect(built.payload(c.result.payload.signature)).toEqual(c.result.payload);
  });

  it('signs the same Permit2 transfer, and builds the same payload', () => {
    const c = vectors.authCapturePermit2;
    const built = buildAuthCapture({
      option: optionOf(c.requirements),
      payer: PAYER,
      now: vectors.nowSeconds,
      random: c.result.payload.salt,
    });
    expect(built.method).toBe('permit2');
    expect(built.document.primaryType).toBe('PermitTransferFrom');
    expect(built.document.domain).toEqual(c.signed[0]!.domain);
    expect(built.document.message).toEqual(c.signed[0]!.message);
    expect(built.payload(c.result.payload.signature)).toEqual(c.result.payload);
  });

  it('derives the same bound salt when a receiver authorizer or policy is named', () => {
    const c = vectors.authCaptureBound;
    const built = buildAuthCapture({
      option: optionOf(c.requirements),
      payer: PAYER,
      now: vectors.nowSeconds,
      random: c.result.payload.saltNonce,
    });
    expect(built.document.message).toEqual(c.signed[0]!.message);
    expect(built.payload(c.result.payload.signature)).toEqual(c.result.payload);
    const extra = c.requirements.extra as Record<string, string>;
    expect(
      deriveBoundSalt(extra.receiverAuthorizer!, extra.policy!, c.result.payload.saltNonce),
    ).toBe(c.result.payload.salt);
  });

  it('the hold is for the quoted amount and lapses when the authorization does', () => {
    const c = vectors.authCapture3009;
    const built = buildAuthCapture({
      option: optionOf(c.requirements),
      payer: PAYER,
      now: vectors.nowSeconds,
      random: c.result.payload.salt,
    });
    expect(built.maxAmount).toBe(5000n);
    expect(built.expiresAt).toBe(vectors.nowSeconds + 300);
  });
});

describe('what an auth-capture quote has to carry', () => {
  const base = vectors.authCapture3009.requirements as { extra: Record<string, unknown> };
  const failWith = (extra: Record<string, unknown>) => {
    try {
      buildAuthCapture({
        option: optionOf({ ...base, extra }),
        payer: PAYER,
        now: vectors.nowSeconds,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(X402Error);
      expect((e as X402Error).code).toBe(ExitCode.INVALID_402);
      return (e as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it.each([
    'captureAuthorizer',
    'feeRecipient',
    'captureDeadline',
    'refundDeadline',
    'minFeeBps',
    'maxFeeBps',
  ])('refuses a quote without extra.%s, naming it', (key) => {
    expect(failWith({ ...base.extra, [key]: undefined })).toContain(key);
  });

  it('refuses an escrow it does not know, so a quote cannot point the funds at a contract of its choosing', () => {
    expect(
      failWith({ ...base.extra, authCaptureEscrow: '0x9999999999999999999999999999999999999999' }),
    ).toMatch(/escrow/);
  });

  it('refuses an asset transfer method it does not know', () => {
    expect(failWith({ ...base.extra, assetTransferMethod: 'telepathy' })).toMatch(
      /assetTransferMethod/,
    );
  });

  it('resolves the known escrows, and defaults to v1.1', () => {
    expect(resolveDeployment(undefined)).toBe(DEPLOYMENT_V1_1);
    expect(resolveDeployment(DEPLOYMENT_V1_0.escrow.toLowerCase())).toBe(DEPLOYMENT_V1_0);
    expect(resolveDeployment(DEPLOYMENT_V1_1.escrow)).toBe(DEPLOYMENT_V1_1);
  });

  it('the payer is the signer, never read from the quote', () => {
    const built = buildAuthCapture({
      option: optionOf({
        ...base,
        extra: { ...base.extra, payer: '0x9999999999999999999999999999999999999999' },
      }),
      payer: PAYER,
      now: vectors.nowSeconds,
    });
    expect(built.document.message.from).toBe(PAYER);
  });
});
