import { X402Error, ExitCode, messageOf, type ExitCodeValue } from '../errors.js';
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

/**
 * The subset of the OWS bindings this package is allowed to call.
 *
 * `deleteWallet`, `exportWallet` and `renameWallet` exist in
 * `@open-wallet-standard/core` and are **deliberately absent here**. This CLI
 * must never destroy a wallet, rename one out from under another tool, or pull
 * a secret out of the vault — a wallet holds money, and removing it from *this
 * tool* must never mean removing it from OWS. `rh-x402 wallet forget` hides a
 * wallet locally and leaves the vault alone.
 *
 * `test/owssafety.test.ts` fails if any of those names appears in `src/`, so
 * this is a guarantee rather than an intention.
 */
export interface OwsCoreModule {
  listWallets(vaultPath?: string): OwsWallet[];
  getWallet(nameOrId: string, vaultPath?: string): OwsWallet;
  /**
   * Used only by the guided setup, never by the payment loop. The signing path
   * must never create a wallet as a side effect of a call.
   */
  createWallet(name: string, passphrase?: string, words?: number, vaultPath?: string): OwsWallet;
  createPolicy(policyJson: string, vaultPath?: string): void;
  createApiKey(
    name: string,
    walletIds: string[],
    policyIds: string[],
    passphrase: string,
    expiresAt?: string,
    vaultPath?: string,
  ): { token: string; id: string; name: string };
  signTypedData(
    wallet: string,
    chain: string,
    typedDataJson: string,
    passphrase?: string,
    index?: number | null,
    vaultPath?: string,
  ): OwsSignResult;
}

/**
 * Whether a loaded module exports every binding {@link OwsCoreModule} names, as
 * a function. Checked on load, so a release that moved one fails before signing.
 */
function isOwsCoreModule<T extends object>(mod: T): mod is T & OwsCoreModule {
  return (
    'listWallets' in mod &&
    typeof mod.listWallets === 'function' &&
    'getWallet' in mod &&
    typeof mod.getWallet === 'function' &&
    'createWallet' in mod &&
    typeof mod.createWallet === 'function' &&
    'createPolicy' in mod &&
    typeof mod.createPolicy === 'function' &&
    'createApiKey' in mod &&
    typeof mod.createApiKey === 'function' &&
    'signTypedData' in mod &&
    typeof mod.signTypedData === 'function'
  );
}

/** Load the bindings on demand, mapping absence onto the usual exit 47. */
export async function loadOwsCore(): Promise<OwsCoreModule> {
  // A non-literal specifier keeps the native module out of the compile graph.
  const specifier = '@open-wallet-standard/core';
  try {
    const mod: object = await import(specifier);
    if (isOwsCoreModule(mod)) return mod;
  } catch {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      'the ows-core signer backend needs the optional peer dependency ' +
        '`@open-wallet-standard/core` (npm i @open-wallet-standard/core). ' +
        'It ships prebuilt bindings for macOS and Linux on x64 and arm64 only.',
    );
  }
  throw new X402Error(
    ExitCode.OWS_UNREACHABLE,
    'the installed @open-wallet-standard/core is missing a binding this CLI calls ' +
      '(listWallets, getWallet, createWallet, createPolicy, createApiKey, signTypedData); ' +
      'upgrade it (npm i @open-wallet-standard/core@latest).',
  );
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
  if (/api key not found|invalid api key/i.test(message)) {
    return (
      `the OWS API key was not accepted (${message}). It may have been revoked, or the ` +
      'token may be from a different vault. Mint a new one with `rh-x402 wallet policy`.'
    );
  }
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

  /**
   * The credential handed to OWS, and the single most consequential choice in
   * this backend.
   *
   * An API key token puts the OWS policy engine in front of the signature; the
   * vault passphrase is owner access and is gated by nothing. Verified by
   * signing the same payload both ways against a policy allowing only Base
   * USDC: the token was refused for another contract, the passphrase signed it.
   */
  private credential(): string | undefined {
    if (this.config.apiKey) return this.config.apiKey;
    if (this.config.requireApiKey) {
      // Never fall through to the passphrase here. This wallet was set up
      // behind a policy, and signing with owner access instead would keep
      // payments working while quietly removing the control — the operator
      // would have no way to notice.
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        'this wallet is configured to sign only with an OWS API key, and none is set. ' +
          'Export OWS_X402_KEY (the token from `rh-x402 wallet policy`). Refusing to fall ' +
          'back to the vault passphrase, which would sign without the policy.',
      );
    }
    return this.config.passphrase;
  }

  async capabilities(): Promise<SignerCapabilities> {
    // Declared, not assumed: these come from the package's own API surface,
    // and `policies` reflects which credential is actually configured rather
    // than what the backend is capable of in principle. Saying `true` while
    // signing with a passphrase would promise a spend control that is not
    // there, which is the expensive direction to be wrong in.
    //
    // `balances: false` is not conservatism: the package exports no balance
    // function, so the pre-flight funding check is skipped, not guessed.
    return {
      typedData: true,
      // True when no signature from this backend can bypass a policy: either a
      // key is set, or one is required and its absence is an error.
      policies: this.config.apiKey !== undefined || this.config.requireApiKey === true,
      balances: false,
      accounts: true,
      declared: true,
    };
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
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        `ows-core has no wallet "${this.wallet}": ${messageOf(err)}`,
      );
    }
    // Outside the try: a wallet that exists but has no EVM account carries its
    // own message, and wrapping it as "no wallet" would be a lie.
    return evmAddressOf(wallet);
  }

  async signTypedData(typedData: TypedData): Promise<string> {
    const ows = await this.load();
    const chain = owsChainName(String(typedData.domain.chainId ?? ''));
    // Resolved outside the try: this can refuse on its own terms, and its exit
    // code must survive rather than being re-derived from the message below.
    const credential = this.credential();
    let result: OwsSignResult;
    try {
      result = ows.signTypedData(
        this.wallet,
        chain,
        JSON.stringify(typedData),
        credential,
        null,
        this.config.vaultPath,
      );
    } catch (err) {
      const message = messageOf(err);
      throw new X402Error(
        exitCodeForOwsCoreError(message),
        `ows-core refused to sign: ${explainOwsCoreError(message)}`,
      );
    }
    return normaliseSignature(result.signature);
  }
}
