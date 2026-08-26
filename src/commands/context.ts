import { loadConfig, type X402Config, type PayloadLevel } from '../core/config.js';
import { X402Error, ExitCode } from '../core/errors.js';
import { Engine } from '../core/engine.js';
import { SessionBudget } from '../core/gates.js';
import { TelemetrySink } from '../core/telemetry.js';
import { OwsClient, OwsSigner, type Signer } from '../core/ows.js';
import { UnsafeLocalSigner } from '../core/unsafe-signer.js';
import { parseUnits } from '../core/assets.js';
import { bool, num, str, type ParsedArgs } from '../core/args.js';

export interface Context {
  config: X402Config;
  sources: string[];
  engine: Engine;
  sink: TelemetrySink;
  budget: SessionBudget;
  walletName: string | undefined;
  ows: OwsClient;
  signer: () => Promise<Signer>;
  payloadLevel: PayloadLevel | undefined;
}

function payloadLevelOf(value: string | undefined): PayloadLevel | undefined {
  if (value === undefined) return undefined;
  if (value === 'none' || value === 'hash' || value === 'full') return value;
  throw new X402Error(ExitCode.GENERIC, `--telemetry-payload must be none|hash|full, got ${value}`);
}

/** Assemble config, wallet, engine and telemetry from parsed flags. */
export function buildContext(parsed: ParsedArgs): Context {
  const overrides: Record<string, unknown> = {};
  const chain = str(parsed.flags, 'chain');
  const timeout = num(parsed.flags, 'timeout');
  if (chain || timeout !== undefined) {
    overrides.defaults = {
      ...(chain ? { chain } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }
  const level = payloadLevelOf(str(parsed.flags, 'telemetry-payload'));
  if (level) overrides.telemetry = { payload: level };

  const { config, sources } = loadConfig({
    file: str(parsed.flags, 'config'),
    overrides,
  });

  const walletName = str(parsed.flags, 'wallet') ?? config.wallet.default;
  const ows = new OwsClient({ endpoint: config.wallet.owsEndpoint, apiKey: config.wallet.apiKey });

  const keyFile = str(parsed.flags, 'unsafe-private-key-file');
  let cached: Signer | undefined;
  const signer = async (): Promise<Signer> => {
    if (cached) return cached;
    if (keyFile) {
      cached = new UnsafeLocalSigner(keyFile);
      return cached;
    }
    if (!walletName) {
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        'no wallet selected: pass --wallet or set wallet.default in ~/.x402/config.json',
      );
    }
    cached = new OwsSigner(ows, walletName);
    return cached;
  };

  const budgetFlag = str(parsed.flags, 'budget');
  // Session budgets are denominated in the asset being paid; USDC's 6 decimals
  // are the v1 assumption, matching limits.maxPerCall.
  const budget = new SessionBudget(budgetFlag ? parseUnits(budgetFlag, 6) : undefined);
  const sink = new TelemetrySink(config);

  const engine = new Engine({
    config,
    signer,
    sink,
    budget,
    walletName: keyFile ? 'unsafe-local' : walletName,
  });

  return {
    config,
    sources,
    engine,
    sink,
    budget,
    walletName,
    ows,
    signer,
    payloadLevel: level,
  };
}

export function callOptionsFrom(parsed: ParsedArgs) {
  return {
    method: str(parsed.flags, 'method'),
    timeoutSeconds: num(parsed.flags, 'timeout'),
    max: str(parsed.flags, 'max'),
    chains: str(parsed.flags, 'chain') ? [str(parsed.flags, 'chain')!] : undefined,
    dryRun: bool(parsed.flags, 'dry-run'),
    noCache: bool(parsed.flags, 'no-cache'),
    form: bool(parsed.flags, 'form'),
    bodyAlways: bool(parsed.flags, 'body-always'),
  };
}
