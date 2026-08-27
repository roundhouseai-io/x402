import { X402Error, ExitCode } from '../errors.js';
import { OwsClient, OwsSigner } from '../ows.js';
import { LocalSigner } from './local.js';
import { ExecSigner } from './exec.js';
import type {
  ExecBackendConfig,
  LocalBackendConfig,
  OwsBackendConfig,
  X402Config,
} from '../config.js';
import type { SignerBackend, SignerFactory, SignerSelector } from '../signer.js';

export const BUILTIN_BACKENDS = ['ows', 'local', 'exec'] as const;
export type BuiltinBackend = (typeof BUILTIN_BACKENDS)[number];

/** Third-party backends live in `x402-signer-<name>` packages. */
export const thirdPartyPackage = (backend: string) => `x402-signer-${backend}`;

interface ThirdPartyModule {
  createSigner(input: { config: unknown; wallet: string }): SignerBackend | Promise<SignerBackend>;
}

function requireWallet(backend: string, wallet: string | undefined): string {
  if (!wallet) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `no wallet selected for the ${backend} backend: pass --wallet or set wallet.default`,
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
      const ows = (backends.ows ?? {}) as OwsBackendConfig;
      const client = new OwsClient({
        endpoint: ows.endpoint,
        apiKey: ows.apiKey,
        ...(ows.timeoutMs ? { timeoutMs: ows.timeoutMs } : {}),
      });
      return new OwsSigner(client, requireWallet(backend, wallet));
    }
    case 'local': {
      const local = (backends.local ?? {}) as LocalBackendConfig;
      return new LocalSigner(requireWallet(backend, wallet), local);
    }
    case 'exec': {
      const exec = (backends.exec ?? {}) as ExecBackendConfig;
      return new ExecSigner(requireWallet(backend, wallet), exec);
    }
    default: {
      // Auto-discover a published backend rather than failing on an unknown name.
      const specifier = thirdPartyPackage(backend);
      let mod: ThirdPartyModule;
      try {
        mod = (await import(specifier)) as unknown as ThirdPartyModule;
      } catch {
        throw new X402Error(
          ExitCode.OWS_UNREACHABLE,
          `unknown signer backend "${backend}": not built in (${BUILTIN_BACKENDS.join(', ')}) ` +
            `and ${specifier} is not installed`,
        );
      }
      if (typeof mod.createSigner !== 'function') {
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
