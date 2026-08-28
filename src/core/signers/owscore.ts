import { X402Error, ExitCode, type ExitCodeValue } from '../errors.js';
import { findChain } from '../assets.js';
import type { TypedData } from '../eip3009.js';
import type { SignerAccount, SignerBackend, SignerCapabilities } from '../signer.js';
import type { OwsCoreBackendConfig } from '../config.js';

/**
 * In-process OWS, via the `@open-wallet-standard/core` native bindings.
 *
 * The HTTP `ows` backend talks to a running daemon; this one loads the vault
 * directly, so there is no service to start and the key still never leaves
 * OWS — the engine hands over one EIP-712 payload and gets a signature back.
 *
 * `@open-wallet-standard/core` is an *optional* peer dependency, so a default
 * install carries no signing code at all, exactly as with `ethers`.
 */

interface OwsAccount {
  chainId: string;
  address: string;
}
export interface OwsWallet {
  id: string;
  name: string;
  accounts: OwsAccount[];
}
interface OwsSignResult {
  signature: string;
  recoveryId?: number;
}

export interface OwsCoreModule {
  listWallets(vaultPath?: string): OwsWallet[];
  getWallet(nameOrId: string, vaultPath?: string): OwsWallet;
  /**
   * Used only by the guided setup, never by the payment loop. The signing path
   * must never create a wallet as a side effect of a call.
   */
  createWallet(name: string, passphrase?: string, words?: number, vaultPath?: string): OwsWallet;
  signTypedData(
    wallet: string,
    chain: string,
    typedDataJson: string,
    passphrase?: string,
    index?: number | null,
    vaultPath?: string,
  ): OwsSignResult;
}

/** Load the bindings on demand, mapping absence onto the usual exit 47. */
export async function loadOwsCore(): Promise<OwsCoreModule> {
  // A non-literal specifier keeps the native module out of the compile graph.
  const specifier = '@open-wallet-standard/core';
  try {
    // SAFETY: a dynamic import is typed `any` because the specifier is not a
    // literal. The shape is asserted, not checked — a version of the package
    // that moved these functions surfaces as a TypeError from the call site,
    // which the callers below map onto exit 47 rather than paying with.
    return (await import(specifier)) as unknown as OwsCoreModule;
  } catch {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      'the ows-core signer backend needs the optional peer dependency ' +
        '`@open-wallet-standard/core` (npm i @open-wallet-standard/core). ' +
        'It ships prebuilt bindings for macOS and Linux on x64 and arm64 only.',
    );
  }
}

/**
 * OWS names EVM chains by name (`base`, `ethereum`), not CAIP-2, and warns that
 * the older `evm` alias is deprecated. Map through the chain table so callers
 * keep using the vocabulary the rest of the tool uses.
 */
export function owsChainName(chain: string | undefined): string {
  const known = findChain(chain);
  if (!known) return chain ?? 'base';
  // base-sepolia and friends keep their own names; only the mainnet alias differs.
  return known.network;
}

/**
 * A policy refusal is a decision, not an outage: it maps to 42 so an agent
 * stops rather than retrying, and never falls back to another backend.
 * Anything else is the backend failing to answer, which is 47.
 */
export function exitCodeForOwsCoreError(message: string): ExitCodeValue {
  return /polic|denied|refus|not permitted/i.test(message)
    ? ExitCode.POLICY_DENIED
    : ExitCode.OWS_UNREACHABLE;
}

/**
 * Translate the one OWS failure that is both common and unreadable.
 *
 * A wrong or missing vault passphrase surfaces from the Rust core as
 * `decryption failed: aead::Error`. It is worth special-casing because
 * everything up to that point looks healthy — `signer check` reports the
 * address fine, since that is unencrypted metadata — so the first sign of
 * trouble is a failed payment with a message naming an AEAD library.
 */
export function explainOwsCoreError(message: string): string {
  if (/aead|decryption failed/i.test(message)) {
    return (
      `the vault passphrase is wrong or missing (${message}). Set OWS_VAULT_PASS, ` +
      'or `rh-x402 config set wallet.backends.ows-core.passphrase env:OWS_VAULT_PASS`, ' +
      'to the passphrase this vault was created with.'
    );
  }
  return message;
}

/**
 * The bindings return 65 bytes with `v` already appended, but *without* a `0x`
 * prefix. Handing that to the X-PAYMENT encoder unprefixed produces a header no
 * facilitator will accept, so normalise here rather than at the call site.
 */
export function normaliseSignature(raw: string): string {
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `ows-core returned a ${Math.floor(hex.length / 2)}-byte signature; expected 65`,
    );
  }
  return `0x${hex}`;
}

/** OWS derives one address per chain family; the EVM one is what x402 pays from. */
export function evmAddressOf(wallet: OwsWallet): string {
  const evm = wallet.accounts.find((a) => a.chainId.startsWith('eip155:'));
  if (!evm) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `ows-core wallet "${wallet.name}" has no EVM account`,
    );
  }
  return evm.address;
}

export class OwsCoreSigner implements SignerBackend {
  readonly backend = 'ows-core';

  /**
   * `load` is injectable so the sign path can be exercised without the native
   * package installed; production always gets `loadOwsCore`.
   */
  constructor(
    readonly wallet: string,
    private readonly config: OwsCoreBackendConfig = {},
    private readonly load: () => Promise<OwsCoreModule> = loadOwsCore,
  ) {}

  async capabilities(): Promise<SignerCapabilities> {
    // Declared, not assumed: these come from the package's own API surface.
    //
    // `policies: false` is the conservative reading, and deliberately so. OWS
    // describes its policy engine as gating *agent (API key)* operations, and
    // `createApiKey(name, walletIds, policyIds, ...)` is what binds a policy to
    // a caller; `signTypedData` takes no key or policy argument, so an
    // in-process call authenticated by the vault passphrase has nothing to bind
    // one to. Claiming `true` here would tell an operator they have a spend
    // control they may not have, which is the expensive direction to be wrong
    // in. A binding policy layer means an API key and the HTTP `ows` backend.
    //
    // `balances: false` is not conservatism: the package exports no balance
    // function at all, so the pre-flight funding check is skipped, not guessed.
    return { typedData: true, policies: false, balances: false, accounts: true, declared: true };
  }

  async getAccounts(): Promise<SignerAccount[]> {
    const ows = await this.load();
    const wallets = ows.listWallets(this.config.vaultPath);
    return wallets.map((w) => ({
      id: w.name,
      address: evmAddressOf(w),
      chains: w.accounts.map((a) => a.chainId),
    }));
  }

  async getAddress(): Promise<string> {
    const ows = await this.load();
    let wallet: OwsWallet;
    try {
      wallet = ows.getWallet(this.wallet, this.config.vaultPath);
    } catch (err) {
      // SAFETY: `err` is whatever the bindings threw. Only `.message` is read,
      // and reading it off a non-Error yields `undefined`, not a throw.
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        `ows-core has no wallet "${this.wallet}": ${(err as Error).message}`,
      );
    }
    // Outside the try: a wallet that exists but has no EVM account carries its
    // own message, and wrapping it as "no wallet" would be a lie.
    return evmAddressOf(wallet);
  }

  async signTypedData(typedData: TypedData): Promise<string> {
    const ows = await this.load();
    const chain = owsChainName(String(typedData.domain.chainId ?? ''));
    let result: OwsSignResult;
    try {
      result = ows.signTypedData(
        this.wallet,
        chain,
        JSON.stringify(typedData),
        this.config.passphrase,
        null,
        this.config.vaultPath,
      );
    } catch (err) {
      // SAFETY: as above — `.message` off a non-Error is `undefined`, and the
      // `??` falls back to the stringified value rather than losing the reason.
      const message = (err as Error).message ?? String(err);
      throw new X402Error(
        exitCodeForOwsCoreError(message),
        `ows-core refused to sign: ${explainOwsCoreError(message)}`,
      );
    }
    return normaliseSignature(result.signature);
  }
}
