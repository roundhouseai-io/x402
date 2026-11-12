import { ExitCode, X402Error } from './errors.js';
import { formatUnits } from './assets.js';
import { randomNonce } from './ids.js';
import {
  abi,
  concat,
  eip712Digest,
  eip712DomainSeparator,
  fromHex,
  hashWords,
  keccak256,
  toHex,
} from './keccak.js';
import type { TypedDataDocument, TypedDataField } from './eip3009.js';
import type { PaymentOption } from './x402.js';

/**
 * The x402 `batch-settlement` scheme on EVM, client side: a payment channel.
 *
 * The payer deposits once into an escrow contract, then pays each request with a
 * signed voucher that names a cumulative amount the receiver may claim. Nothing
 * is sent on-chain per request; the receiver batches claims and settles later,
 * and any unclaimed deposit can be refunded cooperatively or withdrawn after a
 * delay. Ported from the reference client in `@x402/evm` (`batch-settlement/client`)
 * and checked against it in test/channel.test.ts.
 *
 * Everything here is pure: no files, no network, no signing. The engine does the
 * signing through the signer backend, and `channelstore.ts` keeps the state.
 */

export const BATCH_SETTLEMENT_SCHEME = 'batch-settlement';

/** The escrow contract. A constant, never read from a quote. */
export const BATCH_SETTLEMENT_ADDRESS = '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003';
export const ERC3009_DEPOSIT_COLLECTOR = '0x4020806089470a89826cB9fB1f4059150b550004';
export const PERMIT2_DEPOSIT_COLLECTOR = '0x4020425FAf3B746C082C2f942b4E5159887B0005';
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_SALT = `0x${'00'.repeat(32)}`;

/** The shortest delay a payer can be made to wait before withdrawing on their own. */
export const MIN_WITHDRAW_DELAY = 900;

/**
 * Unless told otherwise, a deposit covers this many requests of the quoted size.
 * The reference client uses 5 and refuses anything below 3.
 */
export const DEPOSIT_MULTIPLIER = 5n;

export const BATCH_DOMAIN = { name: 'x402 Batch Settlement', version: '1' } as const;

const isAddr = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const sameAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface ChannelConfig {
  payer: string;
  payerAuthorizer: string;
  receiver: string;
  receiverAuthorizer: string;
  token: string;
  withdrawDelay: number;
  salt: string;
}

const CHANNEL_CONFIG_TYPEHASH = keccak256(
  'ChannelConfig(address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt)',
);

const extraOf = (option: PaymentOption): Record<string, unknown> => {
  const e = option.raw.extra;
  return typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {};
};

/**
 * The channel salt. Zero, unless the receiver lets a facilitator manage vouchers
 * and names a refund authorizer: that address is packed into the low 20 bytes, so
 * the channel id commits to it. With zero entropy the high 12 bytes are zero.
 */
export function channelSalt(option: PaymentOption): string {
  const extra = extraOf(option);
  const refundAuthorizer = extra.refundAuthorizer;
  if (
    extra.voucherManager === 'facilitator' &&
    isAddr(refundAuthorizer) &&
    !sameAddr(refundAuthorizer, ZERO_ADDRESS)
  ) {
    return toHex(concat([new Uint8Array(12), fromHex(refundAuthorizer)]));
  }
  return ZERO_SALT;
}

/**
 * The channel a quote names, for this payer. Needs `extra.receiverAuthorizer`: it
 * is the account the receiver has chosen to authorize claims, and without it the
 * escrow cannot be configured. The payer's own authorizer is the payer.
 */
export function buildChannelConfig(option: PaymentOption, payer: string): ChannelConfig {
  const extra = extraOf(option);
  const receiverAuthorizer = extra.receiverAuthorizer;
  if (!isAddr(receiverAuthorizer) || sameAddr(receiverAuthorizer, ZERO_ADDRESS)) {
    throw new X402Error(
      ExitCode.INVALID_402,
      'a batch-settlement quote must carry a non-zero extra.receiverAuthorizer. Nothing was signed.',
    );
  }
  const salt = channelSalt(option);
  const delay = extra.withdrawDelay;
  return {
    payer,
    payerAuthorizer: payer,
    receiver: option.payTo,
    receiverAuthorizer,
    token: option.asset,
    withdrawDelay:
      typeof delay === 'number' && Number.isInteger(delay) && delay >= 0
        ? delay
        : MIN_WITHDRAW_DELAY,
    salt,
  };
}

export function batchDomain(chainId: number): TypedDataDocument['domain'] {
  return { ...BATCH_DOMAIN, chainId, verifyingContract: BATCH_SETTLEMENT_ADDRESS };
}

/** The channel id: the EIP-712 digest of the configuration under the escrow's domain. */
export function computeChannelId(config: ChannelConfig, chainId: number): string {
  const structHash = hashWords(
    abi.bytes32(CHANNEL_CONFIG_TYPEHASH),
    abi.address(config.payer),
    abi.address(config.payerAuthorizer),
    abi.address(config.receiver),
    abi.address(config.receiverAuthorizer),
    abi.address(config.token),
    abi.uint(config.withdrawDelay, 40),
    abi.bytes32(config.salt),
  );
  return eip712Digest(
    eip712DomainSeparator(batchDomain(chainId) as Required<TypedDataDocument['domain']>),
    structHash,
  );
}

/** The ERC-3009 nonce that binds a deposit authorization to one channel. */
export function depositNonce(channelId: string, salt: string): string {
  return hashWords(abi.bytes32(channelId), abi.uint(BigInt(salt)));
}

const field = (name: string, type: string): TypedDataField => ({ name, type });

const DOMAIN_FULL: TypedDataField[] = [
  field('name', 'string'),
  field('version', 'string'),
  field('chainId', 'uint256'),
  field('verifyingContract', 'address'),
];

/** The voucher the payer signs: the receiver may claim up to this cumulative amount. */
export function voucherDocument(
  channelId: string,
  maxClaimable: bigint,
  chainId: number,
): TypedDataDocument {
  return {
    types: {
      EIP712Domain: DOMAIN_FULL,
      Voucher: [field('channelId', 'bytes32'), field('maxClaimableAmount', 'uint128')],
    },
    primaryType: 'Voucher',
    domain: batchDomain(chainId),
    message: { channelId, maxClaimableAmount: maxClaimable.toString() },
  };
}

export interface DepositInput {
  option: PaymentOption;
  payer: string;
  config: ChannelConfig;
  channelId: string;
  amount: bigint;
  /** Unix seconds. */
  now: number;
  /** 32 random bytes, 0x hex. Becomes the ERC-3009 salt. */
  salt?: string;
  /** A uint256 as a decimal string, for the Permit2 route. */
  permit2Nonce?: string;
}

export type DepositMethod = 'eip3009' | 'permit2';

export function depositMethodOf(option: PaymentOption): DepositMethod {
  const m = extraOf(option).assetTransferMethod;
  if (m === undefined || m === 'eip3009') return 'eip3009';
  if (m === 'permit2') return 'permit2';
  throw new X402Error(
    ExitCode.INVALID_402,
    `unsupported batch-settlement assetTransferMethod "${String(m)}". Nothing was signed.`,
  );
}

/** The ERC-3009 `ReceiveWithAuthorization` that pays the deposit collector. */
export function eip3009DepositDocument(input: DepositInput): {
  document: TypedDataDocument;
  salt: string;
  validBefore: number;
} {
  const { option } = input;
  if (!option.eip712) {
    throw new X402Error(
      ExitCode.INVALID_402,
      `${option.assetSymbol} on ${option.network} has no EIP-712 domain to deposit with`,
    );
  }
  const salt = input.salt ?? randomNonce();
  const validBefore = input.now + Math.max(1, option.maxTimeoutSeconds);
  return {
    salt,
    validBefore,
    document: {
      types: {
        EIP712Domain: DOMAIN_FULL,
        ReceiveWithAuthorization: [
          field('from', 'address'),
          field('to', 'address'),
          field('value', 'uint256'),
          field('validAfter', 'uint256'),
          field('validBefore', 'uint256'),
          field('nonce', 'bytes32'),
        ],
      },
      primaryType: 'ReceiveWithAuthorization',
      domain: {
        name: option.eip712.name,
        version: option.eip712.version,
        chainId: option.chainId,
        verifyingContract: option.asset,
      },
      message: {
        from: input.payer,
        to: ERC3009_DEPOSIT_COLLECTOR,
        value: input.amount.toString(),
        validAfter: '0',
        validBefore: String(validBefore),
        nonce: depositNonce(input.channelId, salt),
      },
    },
  };
}

/** The Permit2 witness transfer that pays the deposit collector and names the channel. */
export function permit2DepositDocument(input: DepositInput): {
  document: TypedDataDocument;
  nonce: string;
  deadline: string;
} {
  const nonce = input.permit2Nonce ?? BigInt(randomNonce()).toString();
  const deadline = String(input.now + Math.max(1, input.option.maxTimeoutSeconds));
  return {
    nonce,
    deadline,
    document: {
      types: {
        EIP712Domain: [
          field('name', 'string'),
          field('chainId', 'uint256'),
          field('verifyingContract', 'address'),
        ],
        PermitWitnessTransferFrom: [
          field('permitted', 'TokenPermissions'),
          field('spender', 'address'),
          field('nonce', 'uint256'),
          field('deadline', 'uint256'),
          field('witness', 'DepositWitness'),
        ],
        TokenPermissions: [field('token', 'address'), field('amount', 'uint256')],
        DepositWitness: [field('channelId', 'bytes32')],
      },
      primaryType: 'PermitWitnessTransferFrom',
      domain: {
        name: 'Permit2',
        chainId: input.option.chainId,
        verifyingContract: PERMIT2_ADDRESS,
      },
      message: {
        permitted: { token: input.option.asset, amount: input.amount.toString() },
        spender: PERMIT2_DEPOSIT_COLLECTOR,
        nonce,
        deadline,
        witness: { channelId: input.channelId },
      },
    },
  };
}

/* ---------------------------------------------------------------------------
   Planning: what this call does to the channel, before anything is signed.
--------------------------------------------------------------------------- */

/** What the client remembers about one channel. Written by channelstore.ts. */
export interface ChannelState {
  /** Everything the receiver has charged so far, as the receiver last reported it. */
  charged: string;
  /** What is in escrow. */
  balance: string;
  /** The highest cumulative amount a voucher has been signed for. */
  signedMax: string;
}

export type ChannelPlan =
  | {
      kind: 'voucher';
      /** The cumulative amount the voucher will name. */
      maxClaimable: bigint;
      /** Compared against `--max` and the per-call cap: the most this request can cost. */
      perCallAtomic: bigint;
      /** New money leaving the wallet. A voucher draws on funds already deposited. */
      exposureAtomic: 0n;
    }
  | {
      kind: 'deposit';
      maxClaimable: bigint;
      deposit: bigint;
      perCallAtomic: bigint;
      exposureAtomic: bigint;
    };

/** `extra.minDeposit`, when the receiver announces one at least as large as the request. */
export function announcedMinDeposit(option: PaymentOption): bigint | undefined {
  const v = extraOf(option).minDeposit;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return undefined;
  const n = BigInt(v);
  return n > 0n && n >= option.amountAtomic ? n : undefined;
}

export interface PlanInput {
  option: PaymentOption;
  state: ChannelState | undefined;
  /** `--deposit`, in atomic units. */
  depositFlag?: bigint | undefined;
  /** The per-call cap in atomic units, when one is set. A default deposit never exceeds it. */
  capAtomic?: bigint | undefined;
  /**
   * How many requests a default deposit targets. Default {@link DEPOSIT_MULTIPLIER}.
   * The reference client refuses a multiplier below 3.
   */
  multiplier?: bigint | undefined;
  /**
   * `--max-deposit` / `channels.maxDeposit`, in atomic units. A hard ceiling:
   * a deposit is never signed above it, and a request that needs more is refused.
   */
  maxDepositAtomic?: bigint | undefined;
}

/**
 * Decide between a voucher on the existing balance and a deposit.
 *
 * What a call can lose, and what each cap compares:
 *  - A voucher is a promise of up to the request amount, from money already in
 *    escrow. The per-call cap compares that amount. It adds no new exposure, so
 *    the session budget and the daily cap do not count it again.
 *  - A deposit moves money out of the wallet now, up to the deposit, so the
 *    per-call cap, the session budget and the daily cap all compare the deposit.
 *    That is also the most the channel can ever cost, so many small vouchers
 *    cannot get past a cap that the deposit already passed.
 * A voucher can never name more than the balance: when it would, the plan is a
 * deposit first.
 */
export function planChannelPayment(input: PlanInput): ChannelPlan {
  const { option, state } = input;
  const request = option.amountAtomic;
  const charged = BigInt(state?.charged ?? '0');
  const balance = BigInt(state?.balance ?? '0');
  const maxClaimable = charged + request;

  if (balance > 0n && maxClaimable <= balance) {
    return { kind: 'voucher', maxClaimable, perCallAtomic: request, exposureAtomic: 0n };
  }

  const multiplier = input.multiplier ?? DEPOSIT_MULTIPLIER;
  if (multiplier < 3n) {
    throw new X402Error(
      ExitCode.GENERIC,
      `deposit multiplier must be an integer >= 3, got ${multiplier.toString()}`,
    );
  }

  const needed = maxClaimable - balance;
  let deposit: bigint;
  if (input.depositFlag !== undefined) {
    if (input.depositFlag < needed) {
      throw new X402Error(
        ExitCode.GENERIC,
        `--deposit ${input.depositFlag.toString()} is below the ${needed.toString()} atomic units this request needs in escrow`,
      );
    }
    deposit = input.depositFlag;
  } else {
    const target = announcedMinDeposit(option) ?? multiplier * request;
    deposit = needed > target ? needed : target;
    // A default deposit never exceeds the cap on one call; only an explicit one can.
    if (input.capAtomic !== undefined && deposit > input.capAtomic && needed <= input.capAtomic) {
      deposit = input.capAtomic;
    }
  }
  const ceiling = input.maxDepositAtomic;
  if (ceiling !== undefined && (needed > ceiling || deposit > ceiling)) {
    const human = (n: bigint) => `${formatUnits(n, option.decimals)} ${option.assetSymbol}`;
    if (needed > ceiling || input.depositFlag !== undefined) {
      throw new X402Error(
        ExitCode.OVER_MAX,
        `deposit of ${human(deposit)} exceeds --max-deposit ${human(ceiling)} ` +
          `(this request needs ${human(needed)} in escrow). Nothing was signed.`,
      );
    }
    deposit = ceiling;
  }
  return {
    kind: 'deposit',
    maxClaimable,
    deposit,
    perCallAtomic: deposit,
    exposureAtomic: deposit,
  };
}

/* ---------------------------------------------------------------------------
   Reading what the receiver says happened.
--------------------------------------------------------------------------- */

export interface ChargeReport {
  /** What this request was charged, when the receiver says. */
  charged: bigint | undefined;
  /** The cumulative amount the receiver now holds charged, when it says. */
  cumulative: bigint | undefined;
}

const uintOf = (v: unknown): bigint | undefined =>
  typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : undefined;

/** Read `extra.chargedAmount` and `extra.channelState.chargedCumulativeAmount` from a settle receipt. */
export function chargeReport(settlement: Record<string, unknown> | undefined): ChargeReport {
  const extra = settlement?.extra;
  if (typeof extra !== 'object' || extra === null)
    return { charged: undefined, cumulative: undefined };
  const e = extra as Record<string, unknown>;
  const state =
    typeof e.channelState === 'object' && e.channelState !== null
      ? (e.channelState as Record<string, unknown>)
      : {};
  return { charged: uintOf(e.chargedAmount), cumulative: uintOf(state.chargedCumulativeAmount) };
}

/**
 * The channel state after a request the receiver accepted.
 *
 * What the receiver reports is believed only inside the limits the payer already
 * set: a charge above the request amount is refused, and a cumulative figure that
 * does not equal the local total plus the charge is ignored, as in the reference
 * client. The deposit, if there was one, is added to the balance.
 */
export function applyCharge(
  prev: ChannelState | undefined,
  report: ChargeReport,
  request: bigint,
  deposit: bigint | undefined,
  signedMax: bigint,
): ChannelState {
  const charged = report.charged ?? 0n;
  if (charged > request) {
    throw new X402Error(
      ExitCode.GENERIC,
      'the receiver charged more than the request amount; the channel state was not updated',
    );
  }
  const prevCharged = BigInt(prev?.charged ?? '0');
  let nextCharged = prevCharged + charged;
  if (report.cumulative !== undefined && report.cumulative !== nextCharged) {
    // The receiver disagrees with the local total. Keep the local one: it can
    // only be lower than the voucher cap, and a corrective 402 repairs it later.
    nextCharged = prevCharged;
  }
  const balance = BigInt(prev?.balance ?? '0') + (deposit ?? 0n);
  const prevSigned = BigInt(prev?.signedMax ?? '0');
  return {
    charged: nextCharged.toString(),
    balance: balance.toString(),
    signedMax: (signedMax > prevSigned ? signedMax : prevSigned).toString(),
  };
}

/** The corrective 402 error codes that mean "your cumulative amount is out of step". */
export const CUMULATIVE_BELOW_CLAIMED = 'invalid_batch_settlement_evm_cumulative_below_claimed';
export const CUMULATIVE_MISMATCH = 'invalid_batch_settlement_evm_cumulative_amount_mismatch';

/**
 * Repair local state from a corrective 402. The receiver names the cumulative
 * amount it holds charged; it is believed only if it is no lower than what the
 * client already knows and no higher than the highest voucher the client has
 * signed, because the receiver cannot have been given more than that. Anything
 * else is a refusal, and the caller stops.
 */
export function repairFromCorrective(
  prev: ChannelState,
  claimed: bigint,
): ChannelState | undefined {
  const known = BigInt(prev.charged);
  const signed = BigInt(prev.signedMax);
  if (claimed < known || claimed > signed) return undefined;
  return { ...prev, charged: claimed.toString() };
}

/** `charged` from the corrective payment-required body (`accepts[].extra.channelState`). */
export function correctiveCharged(accepts: unknown): bigint | undefined {
  if (!Array.isArray(accepts)) return undefined;
  for (const a of accepts) {
    if (typeof a !== 'object' || a === null) continue;
    const rec = a as Record<string, unknown>;
    if (rec.scheme !== BATCH_SETTLEMENT_SCHEME) continue;
    const extra = rec.extra;
    if (typeof extra !== 'object' || extra === null) continue;
    const cs = (extra as Record<string, unknown>).channelState;
    if (typeof cs !== 'object' || cs === null) continue;
    const v = uintOf((cs as Record<string, unknown>).chargedCumulativeAmount);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** The wire payloads. */
export interface VoucherFields {
  channelId: string;
  maxClaimableAmount: string;
  signature: string;
}

export function voucherPayload(
  config: ChannelConfig,
  voucher: VoucherFields,
): Record<string, unknown> {
  return { type: 'voucher', channelConfig: config, voucher };
}

export function depositPayload(
  config: ChannelConfig,
  voucher: VoucherFields,
  amount: bigint,
  authorization: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'deposit',
    channelConfig: config,
    voucher,
    deposit: { amount: amount.toString(), authorization },
  };
}

export function refundPayload(
  config: ChannelConfig,
  voucher: VoucherFields,
  amount?: string,
): Record<string, unknown> {
  return {
    type: 'refund',
    channelConfig: config,
    voucher,
    ...(amount !== undefined ? { amount } : {}),
  };
}

/**
 * The channel after a cooperative refund. A refund of everything, or of at least
 * what is left, ends the channel (undefined: forget it); a partial one lowers the
 * balance. What is left to refund is the balance less what has been charged.
 */
export function afterRefund(
  prev: ChannelState,
  refunded: bigint | undefined,
): ChannelState | undefined {
  if (refunded === undefined) return undefined;
  const balance = BigInt(prev.balance);
  const charged = BigInt(prev.charged);
  const refundable = balance > charged ? balance - charged : 0n;
  if (refunded >= refundable) return undefined;
  return { ...prev, balance: (balance - refunded).toString() };
}
