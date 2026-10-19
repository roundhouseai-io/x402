import { X402Error, ExitCode } from '../errors.js';
import { OwsClient, OwsSigner } from '../ows.js';
import { LocalSigner } from './local.js';
import { OwsCoreSigner } from './owscore.js';
import { ExecSigner } from './exec.js';
import type { X402Config } from '../config.js';
import type { JsonValue } from '../json.js';
import type { SignerBackend, SignerFactory, SignerSelector } from '../signer.js';

export const BUILTIN_BACKENDS = ['ows', 'ows-core', 'local', 'exec'] as const;
export type BuiltinBackend = (typeof BUILTIN_BACKENDS)[number];

export function isBuiltinBackend(name: string): name is BuiltinBackend {
  return BUILTIN_BACKENDS.some((builtin) => builtin === name);
}

/** Third-party backends live in `x402-signer-<name>` packages. */
export const thirdPartyPackage = (backend: string) => `x402-signer-${backend}`;

export interface ThirdPartySignerInput {
  /** `wallet.backends.<name>` from config, as written there. */
  config: JsonValue | undefined;
  wallet: string;
}

interface ThirdPartyModule {
  createSigner(input: ThirdPartySignerInput): SignerBackend | Promise<SignerBackend>;
}

/** Whether a loaded backend package exports the `createSigner` entry point. */
function isThirdPartyModule<T extends object>(mod: T): mod is T & ThirdPartyModule {
  return 'createSigner' in mod && typeof mod.createSigner === 'function';
}

function requireWallet(backend: string, wallet: string | undefined): string {
  if (!wallet) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `no wallet selected for the ${backend} backend. Run \`rh-x402 wallet create\` to set ` +
        'one up, or pass --wallet / set wallet.default if you already have one.',
    );
  }
  return wallet;
}

async function construct(
  backend: string,
  wallet: string | undefined,
  config: X402Config,
): Promise<SignerBackend> {
  const backends = config.wallet.backends;

  switch (backend) {
    case 'ows': {
      const ows = backends.ows;
      const client = new OwsClient({
        endpoint: ows.endpoint,
        apiKey: ows.apiKey,
        timeoutMs: ows.timeoutMs || undefined,
      });
      return new OwsSigner(client, requireWallet(backend, wallet));
    }
    case 'ows-core': {
      return new OwsCoreSigner(requireWallet(backend, wallet), backends['ows-core'] ?? {});
    }
    case 'local': {
      return new LocalSigner(requireWallet(backend, wallet), backends.local);
    }
    case 'exec': {
      return new ExecSigner(requireWallet(backend, wallet), backends.exec ?? { command: '' });
    }
    default: {
      // Auto-discover a published backend rather than failing on an unknown name.
      const specifier = thirdPartyPackage(backend);
      let mod: object;
      try {
        mod = await import(specifier);
      } catch {
        throw new X402Error(
          ExitCode.OWS_UNREACHABLE,
          `unknown signer backend "${backend}": not built in (${BUILTIN_BACKENDS.join(', ')}) ` +
            `and ${specifier} is not installed`,
        );
      }
      if (!isThirdPartyModule(mod)) {
        throw new X402Error(
          ExitCode.OWS_UNREACHABLE,
          `${specifier} does not export createSigner({ config, wallet })`,
        );
      }
      return mod.createSigner({
        config: backends[backend],
        wallet: requireWallet(backend, wallet),
      });
    }
  }
}

/**
 * Resolve a signer backend and check it can do what x402 needs *before* any
 * payment is attempted (spec §5.3 rule 2): a backend that declares it cannot
 * sign EIP-712 typed data fails at config time with exit 47, not mid-payment.
 */
export async function resolveSigner(
  config: X402Config,
  selector: SignerSelector = {},
): Promise<SignerBackend> {
  const backend = selector.backend ?? config.wallet.backend;
  const wallet = selector.wallet ?? config.wallet.default;
  const signer = await construct(backend, wallet, config);

  const caps = await signer.capabilities();
  if (!caps.typedData) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `signer backend "${backend}" cannot sign EIP-712 typed data, which the x402 exact scheme requires`,
      { backend, capabilities: caps },
    );
  }
  return signer;
}

/**
 * A caching factory. Capability checks and process spawns happen once per
 * backend and wallet, not once per call.
 */
export function signerFactory(config: X402Config): SignerFactory {
  const cache = new Map<string, Promise<SignerBackend>>();
  return (selector: SignerSelector = {}) => {
    const backend = selector.backend ?? config.wallet.backend;
    const wallet = selector.wallet ?? config.wallet.default ?? '';
    const key = `${backend}:${wallet}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const created = resolveSigner(config, { backend, wallet: wallet || undefined });
    // Do not cache a failure: a fixed config or a restarted helper should work
    // on the next call.
    cache.set(key, created);
    void created.catch(() => cache.delete(key));
    return created;
  };
}
