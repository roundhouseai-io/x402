import { createPrivateKey, createPublicKey, sign as signBytes, type KeyObject } from 'node:crypto';
import { X402Error, ExitCode } from '../errors.js';
import { decodeBase58, encodeBase58 } from '../base58.js';
import type { SolanaEnvBackendConfig } from '../config.js';
import type { TypedData } from '../eip3009.js';
import type { SignerAccount, SignerBackend, SignerCapabilities } from '../signer.js';

export const SOLANA_KEY_ENV = 'X402_SOLANA_PRIVATE_KEY';

/** PKCS#8 wrapper that turns a 32-byte ed25519 seed into a key `node:crypto` can load. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

interface Keypair {
  privateKey: KeyObject;
  address: string;
}

/**
 * Read a Solana secret key the way wallets write one: base58 of the 64 bytes
 * (seed then public key, as Phantom exports it), or the JSON array of 64 numbers
 * `solana-keygen` produces. The public half is checked against the seed, so a
 * truncated or mismatched value fails here rather than signing for an address
 * nobody holds.
 */
export function parseSolanaSecret(text: string): Uint8Array {
  const trimmed = text.trim();
  let bytes: Uint8Array;
  try {
    if (trimmed.startsWith('[')) {
      const list: unknown = JSON.parse(trimmed);
      if (!Array.isArray(list) || !list.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
        throw new Error('expected an array of byte values');
      }
      bytes = Uint8Array.from(list as number[]);
    } else {
      bytes = decodeBase58(trimmed);
    }
  } catch {
    // The reason can quote the value, and the value is the key.
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      'the Solana key is not base58 or a JSON byte array. It is not shown here.',
    );
  }
  if (bytes.length !== 64) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `the Solana key must be 64 bytes (seed and public key), not ${bytes.length}`,
    );
  }
  return bytes;
}

function keypairFrom(secret: Uint8Array): Keypair {
  const seed = secret.subarray(0, 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicKey = Buffer.from(String(jwk.x), 'base64url');
  if (!publicKey.equals(Buffer.from(secret.subarray(32)))) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      'the public half of the Solana key does not match its seed',
    );
  }
  return { privateKey, address: encodeBase58(publicKey) };
}

/**
 * Development and CI backend for Solana: one ed25519 key in an environment
 * variable.
 *
 * This is the weakest custody this CLI has. An environment variable is readable
 * by every process that inherits it and by anyone who can read `/proc/<pid>/environ`,
 * and it is easily pasted into a log or a crash report; the encrypted keystore
 * and OWS exist to avoid exactly that. It is here because the operator asked for
 * it, it warns on every signature, and it must not hold more than a throwaway
 * balance. There is no policy layer behind it: the caps in this CLI are the only
 * spend control.
 */
export class SolanaEnvSigner implements SignerBackend {
  readonly backend = 'solana-env';
  private keypair: Keypair | undefined;

  constructor(
    readonly wallet: string,
    private readonly config: SolanaEnvBackendConfig = {},
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private get variable(): string {
    return this.config.keyEnv ?? SOLANA_KEY_ENV;
  }

  private load(): Keypair {
    if (this.keypair) return this.keypair;
    const value = this.env[this.variable];
    if (!value || value.trim() === '') {
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        `the solana-env backend reads its key from ${this.variable}, which is not set in this shell`,
      );
    }
    this.keypair = keypairFrom(parseSolanaSecret(value));
    return this.keypair;
  }

  async capabilities(): Promise<SignerCapabilities> {
    return {
      typedData: false,
      svm: true,
      policies: false,
      balances: false,
      accounts: true,
      declared: true,
    };
  }

  async getAccounts(): Promise<SignerAccount[]> {
    return [{ id: this.wallet, address: this.load().address, chains: ['solana'] }];
  }

  async getAddress(): Promise<string> {
    return this.load().address;
  }

  signTypedData(_typedData: TypedData): Promise<string> {
    return Promise.reject(
      new X402Error(
        ExitCode.OWS_UNREACHABLE,
        'the solana-env backend signs Solana transactions, not EIP-712 typed data',
      ),
    );
  }

  async signSvmMessage(message: Uint8Array): Promise<Uint8Array> {
    const { privateKey } = this.load();
    process.stderr.write(
      `x402: WARNING signing with the solana-env backend (key from ${this.variable}). ` +
        'Development only: the key sits in the environment and there is no policy layer behind it.\n',
    );
    return new Uint8Array(signBytes(null, message, privateKey));
  }
}
