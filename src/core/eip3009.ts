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

interface SchemePayload {
  signature: string;
  authorization: TypedData['message'];
}

/** The v1 payload: the chosen option is described by `scheme` + `network`. */
export interface PaymentPayloadV1 {
  x402Version: 1;
  scheme: string;
  network: string;
  payload: SchemePayload;
}

/**
 * The v2 payload (spec 5.2): the whole chosen `PaymentRequirements` object is
 * echoed back under `accepted`, alongside the resource and any extensions the
 * server declared.
 */
export interface PaymentPayloadV2 {
  x402Version: 2;
  resource?: Record<string, unknown>;
  accepted: Record<string, unknown>;
  payload: SchemePayload;
  extensions?: Record<string, unknown>;
}

export type PaymentPayload = PaymentPayloadV1 | PaymentPayloadV2;

/**
 * The header a payment payload travels in.
 *
 * v1 used `X-PAYMENT`; v2 renamed it to `PAYMENT-SIGNATURE` and providers on
 * the current index reject the old one outright ("X-PAYMENT/v1 is
 * unsupported"). Header names are compared case-insensitively, and the HTTP
 * layer here keeps them lowercase.
 */
export function paymentHeaderName(x402Version: number): string {
  return x402Version >= 2 ? 'payment-signature' : 'x-payment';
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The `accepted` block of a v2 payload.
 *
 * The provider's own requirements object is echoed verbatim where it has one:
 * the facilitator matches the authorization against the requirements it issued,
 * so re-spelling them from the normalised option would risk a mismatch on a
 * field this CLI does not model (`extra`, fee payers, scheme-specific keys).
 * The normalised form is the fallback for a payload that did not arrive as a
 * canonical requirements object.
 */
function acceptedFor(option: PaymentOption): Record<string, unknown> {
  const raw = option.raw;
  if (isObj(raw) && raw.scheme !== undefined && raw.payTo !== undefined) return raw;
  return {
    scheme: option.scheme,
    network: option.network,
    amount: option.amountAtomic.toString(),
    asset: option.asset,
    payTo: option.payTo,
    maxTimeoutSeconds: option.maxTimeoutSeconds,
    extra: { name: option.eip712.name, version: option.eip712.version },
  };
}

export interface PaymentPayloadContext {
  /** The 402's protocol version. Decides both the payload shape and the header. */
  x402Version: number;
  /** v2 `resource` object, echoed back. */
  resource?: Record<string, unknown> | undefined;
  /** v2 `extensions` map. The client must return at least what it received. */
  extensions?: Record<string, unknown> | undefined;
}

export function buildPaymentPayload(
  option: PaymentOption,
  typedData: TypedData,
  signature: string,
  context: PaymentPayloadContext = { x402Version: 1 },
): PaymentPayload {
  const payload: SchemePayload = { signature, authorization: typedData.message };
  if (context.x402Version >= 2) {
    return {
      x402Version: 2,
      ...(context.resource ? { resource: context.resource } : {}),
      accepted: acceptedFor(option),
      payload,
      ...(context.extensions ? { extensions: context.extensions } : {}),
    };
  }
  return {
    x402Version: 1,
    scheme: option.scheme,
    network: option.network,
    payload,
  };
}

/** The payment header value: base64 of the payment payload JSON. */
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

/**
 * The settlement receipt, from either header spelling.
 *
 * v2 renamed `X-PAYMENT-RESPONSE` to `PAYMENT-RESPONSE`; a provider may send
 * either, so both are read and the v2 name wins where both are present.
 */
export function settlementFromHeaders(
  headers: Record<string, string>,
): SettlementResponse | undefined {
  return (
    decodeSettlement(headers['payment-response']) ?? decodeSettlement(headers['x-payment-response'])
  );
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
