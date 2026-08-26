import { randomNonce } from './ids.js';
import type { PaymentOption } from './x402.js';

export interface TypedDataField {
  name: string;
  type: string;
}

export interface TypedData {
  types: Record<string, TypedDataField[]>;
  primaryType: 'TransferWithAuthorization';
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  message: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES: Record<string, TypedDataField[]> = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

export interface BuildAuthorizationInput {
  option: PaymentOption;
  from: string;
  /** Seconds. Defaults to the option's maxTimeoutSeconds. */
  validForSeconds?: number;
  /** Unix seconds; injectable for deterministic tests. */
  now?: number;
  nonce?: string;
  /** Clock-skew allowance subtracted from validAfter. */
  skewSeconds?: number;
}

export interface Authorization {
  typedData: TypedData;
  validBefore: number;
  nonce: string;
}

/**
 * Build the EIP-3009 `transferWithAuthorization` typed-data document that the
 * facilitator will submit on-chain. The CLI never signs this itself; it hands
 * the document to OWS `signTypedData`.
 */
export function buildAuthorization(input: BuildAuthorizationInput): Authorization {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const skew = input.skewSeconds ?? 60;
  const validFor = input.validForSeconds ?? input.option.maxTimeoutSeconds;
  const validAfter = Math.max(0, now - skew);
  const validBefore = now + Math.max(1, validFor);
  const nonce = input.nonce ?? randomNonce();

  return {
    validBefore,
    nonce,
    typedData: {
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      domain: {
        name: input.option.eip712.name,
        version: input.option.eip712.version,
        chainId: input.option.chainId,
        verifyingContract: input.option.asset,
      },
      message: {
        from: input.from,
        to: input.option.payTo,
        value: input.option.amountAtomic.toString(),
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce,
      },
    },
  };
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: TypedData['message'];
  };
}

export function buildPaymentPayload(
  option: PaymentOption,
  typedData: TypedData,
  signature: string,
  x402Version = 1,
): PaymentPayload {
  return {
    x402Version,
    scheme: option.scheme,
    network: option.network,
    payload: { signature, authorization: typedData.message },
  };
}

/** The `X-PAYMENT` header value: base64 of the payment payload JSON. */
export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function decodePaymentHeader(header: string): PaymentPayload {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayload;
}

/** Parse the `X-PAYMENT-RESPONSE` settlement receipt a facilitator returns. */
export interface SettlementResponse {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  [key: string]: unknown;
}

export function decodeSettlement(
  header: string | null | undefined,
): SettlementResponse | undefined {
  if (!header) return undefined;
  try {
    const text = header.trim().startsWith('{')
      ? header
      : Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(text) as SettlementResponse;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}
