import { ExitCode, X402Error } from './errors.js';
import { ethCall } from './rpc.js';
import { randomNonce } from './ids.js';
import type {
  TypedDataDocument,
  TypedDataField,
  UptoAuthorization,
  UptoSchemePayload,
} from './eip3009.js';

export type { UptoAuthorization, UptoSchemePayload };
import type { PaymentOption } from './x402.js';

/**
 * The x402 `upto` scheme on EVM, client side.
 *
 * `exact` signs an EIP-3009 transfer of one fixed amount. `upto` signs a Permit2
 * witness transfer for a *ceiling*: the server may settle any amount up to it,
 * and settles what the work actually cost. The signature names the one account
 * allowed to move the funds (the x402 upto proxy, a constant here), the payee,
 * and the facilitator allowed to submit it.
 *
 * Ported from the reference client in `@x402/evm` (`upto/client`) and checked
 * against its output in test/upto.test.ts. Permit2 pulls funds through an ERC-20
 * allowance, so a wallet that has never approved Permit2 also signs an EIP-2612
 * permit that the facilitator submits first (the `eip2612GasSponsoring`
 * extension). That needs two read-only RPC calls, which `exact` never did.
 */

/** Uniswap's canonical Permit2, the same address on every chain. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/**
 * The x402 upto Permit2 proxy. A constant, never read from the 402: it is the
 * only `spender` this client will ever sign, so a quote cannot redirect the
 * funds to an address of its own choosing.
 */
export const UPTO_PERMIT2_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';

export const EIP2612_GAS_SPONSORING_KEY = 'eip2612GasSponsoring';

const DOMAIN_TYPE: TypedDataField[] = [
  { name: 'name', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

const PERMIT2_TYPES: Record<string, TypedDataField[]> = {
  EIP712Domain: DOMAIN_TYPE,
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'facilitator', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
};

const EIP2612_TYPES: Record<string, TypedDataField[]> = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

/** The facilitator the 402 names as allowed to settle. Required for `upto`. */
export function facilitatorOf(option: PaymentOption): string {
  const extra = option.raw.extra;
  const addr =
    typeof extra === 'object' && extra !== null
      ? (extra as Record<string, unknown>).facilitatorAddress
      : undefined;
  if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new X402Error(
      ExitCode.INVALID_402,
      'an upto payment option must carry extra.facilitatorAddress. Nothing was signed.',
    );
  }
  return addr;
}

export interface BuiltUpto {
  typedData: TypedDataDocument;
  authorization: UptoAuthorization;
}

export interface BuildUptoInput {
  option: PaymentOption;
  from: string;
  /** Unix seconds; injectable for deterministic tests. */
  now?: number;
  /** A uint256 as a decimal string; injectable for tests. */
  nonce?: string;
}

/** A fresh 256-bit Permit2 nonce, as the decimal string the payload carries. */
export function permit2Nonce(): string {
  return BigInt(randomNonce()).toString();
}

export function buildUptoPermit2(input: BuildUptoInput): BuiltUpto {
  const { option, from } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const authorization: UptoAuthorization = {
    from,
    permitted: { token: option.asset, amount: option.amountAtomic.toString() },
    spender: UPTO_PERMIT2_PROXY,
    nonce: input.nonce ?? permit2Nonce(),
    deadline: String(now + Math.max(1, option.maxTimeoutSeconds)),
    witness: { to: option.payTo, facilitator: facilitatorOf(option), validAfter: '0' },
  };
  return {
    authorization,
    typedData: {
      types: PERMIT2_TYPES,
      primaryType: 'PermitWitnessTransferFrom',
      domain: { name: 'Permit2', chainId: option.chainId, verifyingContract: PERMIT2_ADDRESS },
      message: {
        permitted: authorization.permitted,
        spender: authorization.spender,
        nonce: authorization.nonce,
        deadline: authorization.deadline,
        witness: authorization.witness,
      },
    },
  };
}

/** `allowance(address,address)` and `nonces(address)`. */
const ALLOWANCE = '0xdd62ed3e';
const NONCES = '0x7ecebe00';
const word = (addr: string) => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

function readUint(hex: string, what: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new X402Error(ExitCode.GENERIC, `RPC returned ${hex || '(empty)'} for ${what}`);
  }
  return BigInt(hex);
}

/** How much of the token this wallet has already approved to Permit2. */
export async function readPermit2Allowance(
  rpcUrl: string,
  token: string,
  owner: string,
): Promise<bigint> {
  const data = `${ALLOWANCE}${word(owner)}${word(PERMIT2_ADDRESS)}`;
  return readUint(await ethCall(rpcUrl, token, data), 'allowance');
}

export async function readPermitNonce(
  rpcUrl: string,
  token: string,
  owner: string,
): Promise<bigint> {
  return readUint(await ethCall(rpcUrl, token, `${NONCES}${word(owner)}`), 'nonces');
}

export interface Eip2612Info {
  from: string;
  asset: string;
  spender: string;
  amount: string;
  nonce: string;
  deadline: string;
  signature: string;
  version: '1';
}

export function buildEip2612Permit(input: {
  option: PaymentOption;
  from: string;
  nonce: bigint;
  deadline: string;
}): { typedData: TypedDataDocument; info: Omit<Eip2612Info, 'signature'> } {
  const { option, from } = input;
  if (!option.eip712) {
    throw new X402Error(
      ExitCode.INVALID_402,
      `${option.assetSymbol} on ${option.network} has no EIP-712 domain to build a permit for`,
    );
  }
  const amount = option.amountAtomic.toString();
  return {
    typedData: {
      types: EIP2612_TYPES,
      primaryType: 'Permit',
      domain: {
        name: option.eip712.name,
        version: option.eip712.version,
        chainId: option.chainId,
        verifyingContract: option.asset,
      },
      message: {
        owner: from,
        spender: PERMIT2_ADDRESS,
        value: amount,
        nonce: input.nonce.toString(),
        deadline: input.deadline,
      },
    },
    info: {
      from,
      asset: option.asset,
      spender: PERMIT2_ADDRESS,
      amount,
      nonce: input.nonce.toString(),
      deadline: input.deadline,
      version: '1',
    },
  };
}
