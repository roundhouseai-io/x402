import type { TypedData } from './eip3009.js';

/**
 * The signer-backend interface (spec §5.3).
 *
 * The payment engine never touches key material. It hands a backend one
 * EIP-712 payload and gets a signature back — no URLs, no request bodies, no
 * response bodies — so a malicious or buggy backend cannot exfiltrate call
 * content.
 */
export interface SignerAccount {
  id: string;
  address: string;
  chains?: string[];
}

export interface SignerBalance {
  asset: string;
  chain?: string;
  /** Human decimal amount. */
  amount: string;
  decimals?: number;
}

export interface SignerCapabilities {
  /** EIP-712 typed-data signing. Required for the x402 `exact` scheme on EVM chains. */
  typedData: boolean;
  /**
   * Signs a Solana transaction message with ed25519, for the x402 `exact` scheme
   * on Solana. Optional so a backend that predates Solana still satisfies the
   * interface; absent means false.
   */
  svm?: boolean;
  /** The backend enforces its own spend policies and may refuse to sign. */
  policies: boolean;
  /** The backend can report balances, enabling the pre-flight check. */
  balances: boolean;
  /** The backend can enumerate accounts. */
  accounts: boolean;
  /**
   * False when the backend does not advertise its capabilities and support was
   * assumed. Only a backend that *declares* it cannot sign typed data is
   * rejected at config time.
   */
  declared: boolean;
}

export interface SignerBackend {
  /** Backend name, e.g. `ows`. Recorded in the ledger. */
  readonly backend: string;
  /** Wallet name or id within that backend. */
  readonly wallet: string;
  capabilities(): Promise<SignerCapabilities>;
  getAccounts(): Promise<SignerAccount[]>;
  getAddress(chain?: string): Promise<string>;
  signTypedData(typedData: TypedData): Promise<string>;
  /**
   * Optional: present only when `capabilities().svm` is true. Receives the
   * serialized message of the transaction to pay with, and returns the 64-byte
   * ed25519 signature. Like `signTypedData`, it is given nothing else: no URL,
   * no request body, no response body.
   */
  signSvmMessage?(message: Uint8Array): Promise<Uint8Array>;
  /** Optional: absent when `capabilities().balances` is false. */
  getBalance?(asset: string, chain: string): Promise<SignerBalance | undefined>;
}

export interface SignerSelector {
  /** Backend name; defaults to config `wallet.backend`. */
  backend?: string | undefined;
  /** Wallet within the backend; defaults to config `wallet.default`. */
  wallet?: string | undefined;
}

export type SignerFactory = (selector?: SignerSelector) => Promise<SignerBackend>;

export const DEFAULT_CAPABILITIES: SignerCapabilities = {
  typedData: false,
  policies: false,
  balances: false,
  accounts: false,
  declared: false,
};
