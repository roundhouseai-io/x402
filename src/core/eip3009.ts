import { randomNonce } from './ids.js';
import type { HeaderMap } from './http.js';
import {
  isBoolean,
  isJsonObject,
  isString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from './json.js';
import { MAX_AUTH_WINDOW_SECONDS, type PaymentOption } from './x402.js';

export interface TypedDataField {
  name: string;
  type: string;
}

/** EIP-712 `types`: struct name -> its fields, in encoding order. */
export interface TypedDataTypes {
  [struct: string]: TypedDataField[];
}

export interface TypedData {
  types: TypedDataTypes;
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

export const TRANSFER_WITH_AUTHORIZATION_TYPES: TypedDataTypes = {
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
  const requested = input.validForSeconds ?? input.option.maxTimeoutSeconds;
  const validFor = Math.min(MAX_AUTH_WINDOW_SECONDS, Math.max(1, Math.floor(requested)));
  const validAfter = Math.max(0, now - skew);
  const validBefore = now + validFor;
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
  resource?: JsonObject;
  accepted: JsonObject;
  payload: SchemePayload;
  extensions?: JsonObject;
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
function acceptedFor(option: PaymentOption): JsonObject {
  const raw = option.raw;
  if (raw.scheme !== undefined && raw.payTo !== undefined) return raw;
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
  resource?: JsonObject | undefined;
  /** v2 `extensions` map. The client must return at least what it received. */
  extensions?: JsonObject | undefined;
}

export function buildPaymentPayload(
  option: PaymentOption,
  typedData: TypedData,
  signature: string,
  context: PaymentPayloadContext = { x402Version: 1 },
): PaymentPayload {
  const payload: SchemePayload = { signature, authorization: typedData.message };
  if (context.x402Version >= 2) {
    const v2: PaymentPayloadV2 = { x402Version: 2, accepted: acceptedFor(option), payload };
    if (context.resource) v2.resource = context.resource;
    if (context.extensions) v2.extensions = context.extensions;
    return v2;
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

const AUTHORIZATION_FIELDS = ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'];

/** A payload carrying a signature and every EIP-3009 authorization field as a string. */
function hasSchemePayload(value: JsonObject): boolean {
  const scheme = value.payload;
  if (!isJsonObject(scheme) || !isString(scheme.signature)) return false;
  const auth = scheme.authorization;
  return isJsonObject(auth) && AUTHORIZATION_FIELDS.every((f) => isString(auth[f]));
}

/** A decoded payment header in the v1 or v2 shape {@link buildPaymentPayload} writes. */
export function isPaymentPayload<T>(value: T): value is T & PaymentPayload {
  if (!isJsonObject(value) || !hasSchemePayload(value)) return false;
  if (value.x402Version === 1) return isString(value.scheme) && isString(value.network);
  if (value.x402Version === 2) {
    return (
      isJsonObject(value.accepted) &&
      (value.resource === undefined || isJsonObject(value.resource)) &&
      (value.extensions === undefined || isJsonObject(value.extensions))
    );
  }
  return false;
}

/** Decode a payment header. Throws on anything that is not a v1 or v2 payload. */
export function decodePaymentHeader(header: string): PaymentPayload {
  const decoded = parseJson(Buffer.from(header, 'base64').toString('utf8'));
  if (!isPaymentPayload(decoded)) throw new Error('not an x402 payment payload');
  return decoded;
}

/** Parse the `X-PAYMENT-RESPONSE` settlement receipt a facilitator returns. */
export interface SettlementResponse {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  [key: string]: JsonValue | undefined;
}

/** A settlement receipt whose documented fields, where present, have their documented types. */
export function isSettlementResponse<T>(value: T): value is T & SettlementResponse {
  if (!isJsonObject(value)) return false;
  const optional = (v: JsonValue | undefined, check: (x: JsonValue) => boolean): boolean =>
    v === undefined || check(v);
  return (
    optional(value.success, isBoolean) &&
    optional(value.transaction, isString) &&
    optional(value.network, isString) &&
    optional(value.payer, isString) &&
    optional(value.errorReason, isString)
  );
}

/**
 * The settlement receipt, from either header spelling.
 *
 * v2 renamed `X-PAYMENT-RESPONSE` to `PAYMENT-RESPONSE`; a provider may send
 * either, so both are read and the v2 name wins where both are present.
 */
export function settlementFromHeaders(headers: HeaderMap): SettlementResponse | undefined {
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
    const parsed = parseJson(text);
    return isSettlementResponse(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
