import { ExitCode, X402Error } from './errors.js';
import { randomNonce } from './ids.js';
import { abi, hashWords, keccak256 } from './keccak.js';
import { PERMIT2_ADDRESS } from './channel.js';
import type { TypedDataDocument, TypedDataField } from './eip3009.js';
import type { PaymentOption } from './x402.js';

/**
 * The x402 `auth-capture` scheme on EVM, client side: an authorization hold.
 *
 * The payer signs an authorization that moves up to `maxAmount` into an escrow
 * contract. Nothing is paid yet. The receiver (through its capture authorizer)
 * later captures what the work cost, and the rest of the hold can be voided or
 * reclaimed after the authorization expires. Ported from the reference client in
 * `@x402/evm` (`auth-capture/client`) and checked against it in
 * test/authcapture.test.ts.
 *
 * Pure: no files, no network, no signing.
 */

export const AUTH_CAPTURE_SCHEME = 'auth-capture';

interface Deployment {
  version: string;
  escrow: string;
  eip3009Collector: string;
  permit2Collector: string;
}

/** The escrow deployments the reference client knows. Fixed here: a quote cannot name a new one. */
export const DEPLOYMENT_V1_0: Deployment = {
  version: 'v1.0',
  escrow: '0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff',
  eip3009Collector: '0x0E3dF9510de65469C4518D7843919c0b8C7A7757',
  permit2Collector: '0x992476B9Ee81d52a5BdA0622C333938D0Af0aB26',
};
export const DEPLOYMENT_V1_1: Deployment = {
  version: 'v1.1',
  escrow: '0xf96815976523E00e65Be8f34cA5e64b4f41EB19c',
  eip3009Collector: '0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88',
  permit2Collector: '0xD69831Aed5bfe262067ec4c751f4F830EcdD446e',
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const isAddr = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `extra.authCaptureEscrow` names one of the known escrows, or is absent (v1.1). */
export function resolveDeployment(escrow: unknown): Deployment {
  if (escrow === undefined || escrow === '') return DEPLOYMENT_V1_1;
  if (isAddr(escrow)) {
    if (same(escrow, DEPLOYMENT_V1_1.escrow)) return DEPLOYMENT_V1_1;
    if (same(escrow, DEPLOYMENT_V1_0.escrow)) return DEPLOYMENT_V1_0;
  }
  throw new X402Error(
    ExitCode.INVALID_402,
    `an auth-capture quote names an escrow this CLI does not know (${String(escrow)}). Nothing was signed.`,
  );
}

const PAYMENT_INFO_TYPEHASH = keccak256(
  'PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)',
);
const SALT_BINDING_TYPEHASH = keccak256(
  'x402AuthCaptureSaltBinding(address receiverAuthorizer,address policy,uint256 saltNonce)',
);

export interface PaymentInfo {
  operator: string;
  receiver: string;
  token: string;
  maxAmount: bigint;
  preApprovalExpiry: number;
  authorizationExpiry: number;
  refundExpiry: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: string;
  /** A uint256 as 0x hex. */
  salt: string;
}

/**
 * The payer-agnostic hash of the payment info, which is the nonce the signature
 * commits to. The payer slot is the zero address, so the same hold can be
 * matched to any payer, as the reference client does.
 */
export function payerAgnosticHash(chainId: number, info: PaymentInfo, escrow: string): string {
  const inner = hashWords(
    abi.bytes32(PAYMENT_INFO_TYPEHASH),
    abi.address(info.operator),
    abi.address(ZERO_ADDRESS),
    abi.address(info.receiver),
    abi.address(info.token),
    abi.uint(info.maxAmount, 120),
    abi.uint(info.preApprovalExpiry, 48),
    abi.uint(info.authorizationExpiry, 48),
    abi.uint(info.refundExpiry, 48),
    abi.uint(info.minFeeBps, 16),
    abi.uint(info.maxFeeBps, 16),
    abi.address(info.feeReceiver),
    abi.uint(BigInt(info.salt)),
  );
  return hashWords(abi.uint(chainId), abi.address(escrow), abi.bytes32(inner));
}

export function deriveBoundSalt(
  receiverAuthorizer: string,
  policy: string,
  saltNonce: string,
): string {
  return hashWords(
    abi.bytes32(SALT_BINDING_TYPEHASH),
    abi.address(receiverAuthorizer),
    abi.address(policy),
    abi.uint(BigInt(saltNonce)),
  );
}

const field = (name: string, type: string): TypedDataField => ({ name, type });

export interface AuthCaptureInput {
  option: PaymentOption;
  payer: string;
  /** Unix seconds. */
  now: number;
  /** 32 random bytes as 0x hex: the salt, or the salt nonce when binding is on. */
  random?: string;
}

export interface AuthCaptureBuilt {
  document: TypedDataDocument;
  /** The wire payload minus the signature, which the caller adds. */
  payload: (signature: string) => Record<string, unknown>;
  /** The most this hold can cost. */
  maxAmount: bigint;
  /** Unix seconds after which the signed authorization can no longer be submitted. */
  expiresAt: number;
  nonce: string;
  method: 'eip3009' | 'permit2';
}

const numberOf = (extra: Record<string, unknown>, key: string): number => {
  const v = extra[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new X402Error(
      ExitCode.INVALID_402,
      `an auth-capture quote must carry extra.${key}. Nothing was signed.`,
    );
  }
  return v;
};

const addressOf = (extra: Record<string, unknown>, key: string): string => {
  const v = extra[key];
  if (!isAddr(v)) {
    throw new X402Error(
      ExitCode.INVALID_402,
      `an auth-capture quote must carry extra.${key} as an address. Nothing was signed.`,
    );
  }
  return v;
};

/** Build the document to sign for an auth-capture quote. */
export function buildAuthCapture(input: AuthCaptureInput): AuthCaptureBuilt {
  const { option, payer } = input;
  const extraRaw = option.raw.extra;
  const extra =
    typeof extraRaw === 'object' && extraRaw !== null ? (extraRaw as Record<string, unknown>) : {};
  const operator = addressOf(extra, 'captureAuthorizer');
  const feeReceiver = addressOf(extra, 'feeRecipient');
  const authorizationExpiry = numberOf(extra, 'captureDeadline');
  const refundExpiry = numberOf(extra, 'refundDeadline');
  const minFeeBps = numberOf(extra, 'minFeeBps');
  const maxFeeBps = numberOf(extra, 'maxFeeBps');
  const deployment = resolveDeployment(extra.authCaptureEscrow);

  const method = extra.assetTransferMethod ?? 'eip3009';
  if (method !== 'eip3009' && method !== 'permit2') {
    throw new X402Error(
      ExitCode.INVALID_402,
      `unsupported auth-capture assetTransferMethod "${String(method)}". Nothing was signed.`,
    );
  }

  const maxAmount = option.amountAtomic;
  const preApprovalExpiry = input.now + Math.max(1, option.maxTimeoutSeconds);
  const random = input.random ?? randomNonce();
  const receiverAuthorizer = isAddr(extra.receiverAuthorizer)
    ? extra.receiverAuthorizer
    : ZERO_ADDRESS;
  const policy = isAddr(extra.policy) ? extra.policy : ZERO_ADDRESS;
  const bindOn = !same(receiverAuthorizer, ZERO_ADDRESS) || !same(policy, ZERO_ADDRESS);
  const salt = bindOn ? deriveBoundSalt(receiverAuthorizer, policy, random) : random;

  const info: PaymentInfo = {
    operator,
    receiver: option.payTo,
    token: option.asset,
    maxAmount,
    preApprovalExpiry,
    authorizationExpiry,
    refundExpiry,
    minFeeBps,
    maxFeeBps,
    feeReceiver,
    salt,
  };
  const nonce = payerAgnosticHash(option.chainId, info, deployment.escrow);
  const tail = bindOn ? { salt, saltNonce: random } : { salt };

  if (method === 'permit2') {
    const nonceDecimal = BigInt(nonce).toString();
    const permit2Authorization = {
      from: payer,
      permitted: { token: option.asset, amount: maxAmount.toString() },
      spender: deployment.permit2Collector,
      nonce: nonceDecimal,
      deadline: String(preApprovalExpiry),
    };
    return {
      method: 'permit2',
      maxAmount,
      expiresAt: preApprovalExpiry,
      nonce,
      document: {
        types: {
          EIP712Domain: [
            field('name', 'string'),
            field('chainId', 'uint256'),
            field('verifyingContract', 'address'),
          ],
          PermitTransferFrom: [
            field('permitted', 'TokenPermissions'),
            field('spender', 'address'),
            field('nonce', 'uint256'),
            field('deadline', 'uint256'),
          ],
          TokenPermissions: [field('token', 'address'), field('amount', 'uint256')],
        },
        primaryType: 'PermitTransferFrom',
        domain: { name: 'Permit2', chainId: option.chainId, verifyingContract: PERMIT2_ADDRESS },
        message: {
          permitted: permit2Authorization.permitted,
          spender: permit2Authorization.spender,
          nonce: nonceDecimal,
          deadline: permit2Authorization.deadline,
        },
      },
      payload: (signature) => ({ permit2Authorization, signature, ...tail }),
    };
  }

  if (!option.eip712) {
    throw new X402Error(
      ExitCode.INVALID_402,
      `${option.assetSymbol} on ${option.network} has no EIP-712 domain to authorize with`,
    );
  }
  const authorization = {
    from: payer,
    to: deployment.eip3009Collector,
    value: maxAmount.toString(),
    validAfter: '0',
    validBefore: String(preApprovalExpiry),
    nonce,
  };
  return {
    method: 'eip3009',
    maxAmount,
    expiresAt: preApprovalExpiry,
    nonce,
    document: {
      types: {
        EIP712Domain: [
          field('name', 'string'),
          field('version', 'string'),
          field('chainId', 'uint256'),
          field('verifyingContract', 'address'),
        ],
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
      message: authorization,
    },
    payload: (signature) => ({ authorization, signature, ...tail }),
  };
}
