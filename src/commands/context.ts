import {
  loadConfig,
  type X402Config,
  type PayloadLevel,
  type OwsBackendConfig,
} from '../core/config.js';
import { X402Error, ExitCode } from '../core/errors.js';
import { Engine } from '../core/engine.js';
import { SessionBudget } from '../core/gates.js';
import { TelemetrySink } from '../core/telemetry.js';
import { OwsClient } from '../core/ows.js';
import { signerFactory } from '../core/signers/index.js';
import { parseUnits } from '../core/assets.js';
import { bool, num, str, type ParsedArgs } from '../core/args.js';
import type { SignerFactory } from '../core/signer.js';

export interface Context {
  config: X402Config;
  sources: string[];
  engine: Engine;
  sink: TelemetrySink;
  budget: SessionBudget;
  /** Active wallet within the active backend. */
  walletName: string | undefined;
  /** Active signer backend name. */
  backendName: string;
  /** Client for the OWS backend specifically, used by `wallet` and health checks. */
  ows: OwsClient;
  signer: SignerFactory;
  payloadLevel: PayloadLevel | undefined;
}

function payloadLevelOf(value: string | undefined): PayloadLevel | undefined {
  if (value === undefined) return undefined;
  if (value === 'none' || value === 'hash' || value === 'full') return value;
  throw new X402Error(ExitCode.GENERIC, `--telemetry-payload must be none|hash|full, got ${value}`);
}

/** Assemble config, signer backend, engine and telemetry from parsed flags. */
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

  const backendFlag = str(parsed.flags, 'signer');
  const walletFlag = str(parsed.flags, 'wallet');
  const keystoreFlag = str(parsed.flags, 'keystore');
  const wallet: Record<string, unknown> = {};
  if (backendFlag) wallet.backend = backendFlag;
  if (walletFlag) wallet.default = walletFlag;
  if (keystoreFlag) wallet.backends = { local: { keystore: keystoreFlag } };
  if (Object.keys(wallet).length > 0) overrides.wallet = wallet;

  const { config, sources } = loadConfig({
    file: str(parsed.flags, 'config'),
    overrides,
  });

  const backendName = config.wallet.backend;
  const walletName = config.wallet.default;
  const owsConfig = (config.wallet.backends.ows ?? {}) as OwsBackendConfig;
  const ows = new OwsClient({
    endpoint: owsConfig.endpoint,
    apiKey: owsConfig.apiKey,
    ...(owsConfig.timeoutMs ? { timeoutMs: owsConfig.timeoutMs } : {}),
  });

  const signer = signerFactory(config);

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
    walletName,
    backendName,
  });

  return {
    config,
    sources,
    engine,
    sink,
    budget,
    walletName,
    backendName,
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
