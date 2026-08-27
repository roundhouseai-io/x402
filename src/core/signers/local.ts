import { X402Error, ExitCode } from '../errors.js';
import { decryptEntry, keystorePath, findEntry } from '../keystore.js';
import type { LocalBackendConfig } from '../config.js';
import type { TypedData } from '../eip3009.js';
import type { SignerAccount, SignerBackend, SignerCapabilities } from '../signer.js';
import { readKeystore } from '../keystore.js';

interface EthersWallet {
  address: string;
  signTypedData(
    domain: TypedData['domain'],
    types: Record<string, unknown>,
    message: TypedData['message'],
  ): Promise<string>;
}

/**
 * Load `ethers` on demand. It is an *optional* peer dependency, so a default
 * install of this CLI carries no signing code at all — only the `local`
 * backend needs it, and only when it actually signs.
 */
export async function loadEthers(): Promise<{ Wallet: new (key: string) => EthersWallet }> {
  // A non-literal specifier keeps ethers out of the compile graph.
  const specifier = 'ethers';
  try {
    return (await import(specifier)) as unknown as { Wallet: new (key: string) => EthersWallet };
  } catch {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      'the local signer backend needs the optional peer dependency `ethers` (npm i ethers)',
    );
  }
}

function passphraseFor(config: LocalBackendConfig): string {
  const fromConfig = config.passphrase;
  const fromEnv = process.env.X402_KEYSTORE_PASS;
  const passphrase = fromConfig ?? fromEnv;
  if (!passphrase) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      'local keystore passphrase not set: export X402_KEYSTORE_PASS, ' +
        'or set wallet.backends.local.passphrase to an env: indirection',
    );
  }
  return passphrase;
}

/**
 * Development and CI backend. Keys live only in the encrypted keystore, and
 * every signature warns: `local` has no policy layer, so the CLI-side caps are
 * the only spend control.
 */
export class LocalSigner implements SignerBackend {
  readonly backend = 'local';

  constructor(
    readonly wallet: string,
    private readonly config: LocalBackendConfig,
  ) {}

  async capabilities(): Promise<SignerCapabilities> {
    return { typedData: true, policies: false, balances: false, accounts: true, declared: true };
  }

  async getAccounts(): Promise<SignerAccount[]> {
    return readKeystore(this.config.keystore).entries.map((e) => ({
      id: e.name,
      address: e.address,
    }));
  }

  async getAddress(): Promise<string> {
    return findEntry(this.config.keystore, this.wallet).address;
  }

  async signTypedData(typedData: TypedData): Promise<string> {
    const entry = findEntry(this.config.keystore, this.wallet);
    const key = decryptEntry(entry, passphraseFor(this.config));
    const { Wallet } = await loadEthers();
    const wallet = new Wallet(key);
    process.stderr.write(
      `x402: WARNING signing with the local keystore backend (${keystorePath(this.config.keystore)}, ` +
        `wallet "${this.wallet}"). Development only: there is no policy layer behind this key.\n`,
    );
    const { EIP712Domain: _domain, ...types } = typedData.types;
    return wallet.signTypedData(typedData.domain, types, typedData.message);
  }
}
