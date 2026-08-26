import { readFileSync, statSync } from 'node:fs';
import { X402Error, ExitCode } from './errors.js';
import type { Signer } from './ows.js';
import type { TypedData } from './eip3009.js';

interface EthersWallet {
  address: string;
  signTypedData(
    domain: TypedData['domain'],
    types: Record<string, unknown>,
    message: TypedData['message'],
  ): Promise<string>;
}

/**
 * Local-development signer. Reads a key from a file (never argv, never an env
 * var), warns on every use, and refuses a world-readable file.
 *
 * secp256k1 is not bundled: `ethers` is an optional peer dependency, so a
 * default install of this CLI carries no signing code at all.
 */
export class UnsafeLocalSigner implements Signer {
  readonly wallet = 'unsafe-local';
  private readonly keyFile: string;

  constructor(keyFile: string) {
    this.keyFile = keyFile;
    const stat = statSync(keyFile);
    if (stat.mode & 0o004) {
      throw new X402Error(
        ExitCode.GENERIC,
        `refusing to read a world-readable key file: ${keyFile} (chmod 600 it)`,
      );
    }
    process.stderr.write(
      `x402: WARNING --unsafe-private-key-file is for local development only. ` +
        `Production signing must go through OWS. Key: ${keyFile}\n`,
    );
    if (stat.mode & 0o040) {
      process.stderr.write(`x402: WARNING ${keyFile} is group-readable\n`);
    }
  }

  private key(): string {
    const raw = readFileSync(this.keyFile, 'utf8').trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
      throw new X402Error(ExitCode.GENERIC, `${this.keyFile} does not contain a 32-byte hex key`);
    }
    return raw.startsWith('0x') ? raw : `0x${raw}`;
  }

  private async wallet712(): Promise<{
    address: string;
    signTypedData: (d: TypedData) => Promise<string>;
  }> {
    // A non-literal specifier keeps `ethers` out of the compile graph, so the
    // package stays genuinely optional.
    const specifier = 'ethers';
    let ethers: { Wallet: new (key: string) => EthersWallet };
    try {
      ethers = (await import(specifier)) as unknown as {
        Wallet: new (key: string) => EthersWallet;
      };
    } catch {
      throw new X402Error(
        ExitCode.GENERIC,
        'the unsafe local signer needs the optional peer dependency `ethers` (npm i ethers)',
      );
    }
    const w = new ethers.Wallet(this.key());
    return {
      address: w.address,
      signTypedData: async (d: TypedData) => {
        const { EIP712Domain: _ignored, ...types } = d.types;
        return w.signTypedData(d.domain, types, d.message);
      },
    };
  }

  async address(): Promise<string> {
    return (await this.wallet712()).address;
  }

  async signTypedData(typedData: TypedData): Promise<string> {
    return (await this.wallet712()).signTypedData(typedData);
  }
}
