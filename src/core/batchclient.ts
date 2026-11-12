import { X402Error, ExitCode } from './errors.js';
import { readChannel } from './channelstore.js';
import type { TypedDataDocument, TypedDataField } from './eip3009.js';
import type { SignerBackend } from './signer.js';
import type { PaymentRequirements } from '@x402/core/types';

/**
 * Official client for the x402 `batch-settlement` scheme on EVM.
 *
 * `BatchSettlementEvmScheme` from `@x402/evm/batch-settlement/client` is
 * registered for `eip155:*`, which is what `client.register("eip155:*", scheme)`
 * does in the SDK example. This CLI has one payment engine rather than an
 * `x402Client`, so the engine calls {@link createEvmBatchPayment} and that
 * function is the registration.
 *
 * The package is an optional peer, same as `ethers`: a default install does not
 * download it. When it is absent, the engine signs with the vendored port in
 * `channel.ts`, which was checked against this SDK's output. Signing still goes
 * through `SignerBackend`. The scheme never sees a key.
 *
 * Channel files stay in `~/.x402/channels` (0600). That store is the
 * `ClientChannelStorage` the scheme reads. `FileClientChannelStorage` writes
 * without a private mode, so it is not used for CLI state.
 */

/** The network pattern the scheme is registered for. */
export const EVM_BATCH_NETWORK = 'eip155:*';

export interface SchemeRegistry {
  register(network: string, scheme: { readonly scheme: string }): void;
}

/** `client.register("eip155:*", scheme)`. */
export function registerEvmBatchScheme(
  registry: SchemeRegistry,
  scheme: { readonly scheme: string },
): void {
  registry.register(EVM_BATCH_NETWORK, scheme);
}

export interface EvmBatchRequest {
  signer: SignerBackend;
  payer: string;
  /** Channel slot in `~/.x402/channels`. The scheme reads the record there. */
  slot: string;
  x402Version: number;
  requirements: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  };
  depositMultiplier: number;
  /** Planner chose a voucher. A deposit from the scheme is a refusal. */
  voucherOnly: boolean;
  /** Atomic units the caps already accepted. The scheme signs this deposit. */
  depositAtomic?: bigint;
  /** Per-call cap in atomic units, forwarded as the SDK spend cap. */
  maxAmountPerPayment?: string;
}

export interface EvmBatchResult {
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

function missingPackage(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = 'code' in err ? String(err.code) : '';
  const message = 'message' in err ? String(err.message) : '';
  return code === 'ERR_MODULE_NOT_FOUND' || message.includes("Cannot find package '@x402/evm'");
}

function evmAddress(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new X402Error(ExitCode.GENERIC, 'batch-settlement needs an EVM payer address');
  }
  return `0x${value.slice(2)}`;
}

function hexData(value: string, label: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new X402Error(ExitCode.GENERIC, `${label} is not hex`);
  }
  return `0x${value.slice(2)}`;
}

function caip2(value: string): `${string}:${string}` {
  const idx = value.indexOf(':');
  if (idx <= 0 || idx === value.length - 1) {
    throw new X402Error(
      ExitCode.INVALID_402,
      `batch-settlement needs a CAIP-2 network, got ${value}`,
    );
  }
  return `${value.slice(0, idx)}:${value.slice(idx + 1)}`;
}

function jsonish(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonish);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = jsonish(inner);
    return out;
  }
  return value;
}

function domainOf(raw: Record<string, unknown>): TypedDataDocument['domain'] {
  const chainId = raw.chainId;
  const id = typeof chainId === 'bigint' ? Number(chainId) : Number(chainId);
  const domain: TypedDataDocument['domain'] = {
    name: typeof raw.name === 'string' ? raw.name : '',
    chainId: id,
    verifyingContract: String(raw.verifyingContract),
  };
  if (typeof raw.version === 'string') domain.version = raw.version;
  return domain;
}

function fieldList(value: unknown): TypedDataField[] {
  if (!Array.isArray(value)) return [];
  const out: TypedDataField[] = [];
  for (const field of value) {
    if (typeof field !== 'object' || field === null) continue;
    const name = 'name' in field ? field.name : undefined;
    const type = 'type' in field ? field.type : undefined;
    if (typeof name === 'string' && typeof type === 'string') out.push({ name, type });
  }
  return out;
}

function typesOf(
  raw: Record<string, unknown>,
  domain: TypedDataDocument['domain'],
): TypedDataDocument['types'] {
  const types: Record<string, TypedDataField[]> = {};
  for (const [name, fields] of Object.entries(raw)) types[name] = fieldList(fields);
  if (!types.EIP712Domain) {
    const fields: TypedDataField[] = [];
    if (domain.name !== undefined) fields.push({ name: 'name', type: 'string' });
    if (domain.version !== undefined) fields.push({ name: 'version', type: 'string' });
    fields.push(
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    );
    types.EIP712Domain = fields;
  }
  return types;
}

/**
 * Sign one batch-settlement payload with the official scheme.
 *
 * Returns undefined when `@x402/evm` is not installed. Any other failure is
 * thrown: falling back to a second signature after the scheme has already
 * signed would be a second authorization.
 */
export async function createEvmBatchPayment(
  input: EvmBatchRequest,
): Promise<EvmBatchResult | undefined> {
  let BatchSettlementEvmScheme: typeof import('@x402/evm/batch-settlement/client').BatchSettlementEvmScheme;
  try {
    ({ BatchSettlementEvmScheme } = await import('@x402/evm/batch-settlement/client'));
  } catch (err) {
    if (missingPackage(err)) return undefined;
    throw err;
  }

  const payer = evmAddress(input.payer);
  const signer = {
    address: payer,
    signTypedData: async (message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> => {
      const domain = domainOf(message.domain);
      const signed = jsonish(message.message);
      const fields: Record<string, unknown> = {};
      if (typeof signed === 'object' && signed !== null && !Array.isArray(signed)) {
        for (const [key, inner] of Object.entries(signed)) fields[key] = inner;
      }
      const doc: TypedDataDocument = {
        domain,
        types: typesOf(message.types, domain),
        primaryType: message.primaryType,
        message: fields,
      };
      return hexData(await input.signer.signTypedData(doc), 'signature');
    },
  };

  const storage = {
    async get(key: string) {
      const rec = readChannel(input.slot);
      if (!rec || rec.channelId.toLowerCase() !== key.toLowerCase()) return undefined;
      return {
        chargedCumulativeAmount: rec.charged,
        balance: rec.balance,
        signedMaxClaimable: rec.signedMax,
        ...(rec.voucherSignature && /^0x[0-9a-fA-F]+$/.test(rec.voucherSignature)
          ? { signature: hexData(rec.voucherSignature, 'stored voucher') }
          : {}),
      };
    },
    async set(): Promise<void> {
      // The engine writes the channel file, mode 0600, before the payment is sent.
    },
    async delete(): Promise<void> {
      // Refunds delete the file through the engine.
    },
  };

  const requirements: PaymentRequirements = {
    scheme: input.requirements.scheme,
    network: caip2(input.requirements.network),
    asset: input.requirements.asset,
    amount: input.requirements.amount,
    payTo: input.requirements.payTo,
    maxTimeoutSeconds: input.requirements.maxTimeoutSeconds,
    extra: input.requirements.extra,
  };

  const scheme = new BatchSettlementEvmScheme(signer, {
    depositPolicy: { depositMultiplier: input.depositMultiplier },
    storage,
    depositStrategy: () => {
      if (input.voucherOnly) {
        throw new X402Error(
          ExitCode.GENERIC,
          'the batch-settlement scheme tried to deposit into a channel that can already cover this request. Nothing was signed.',
        );
      }
      return input.depositAtomic?.toString();
    },
  });

  const result = await scheme.createPaymentPayload(
    input.x402Version,
    requirements,
    input.maxAmountPerPayment !== undefined
      ? { maxAmountPerPayment: input.maxAmountPerPayment }
      : undefined,
  );
  const rawPayload = jsonish(result.payload);
  if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
    throw new X402Error(
      ExitCode.GENERIC,
      'the batch-settlement scheme returned an empty payload. Nothing was signed.',
    );
  }
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawPayload)) payload[key] = value;
  return {
    payload,
    ...(result.extensions ? { extensions: result.extensions } : {}),
  };
}
