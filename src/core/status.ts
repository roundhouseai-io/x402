import { VERSION } from '../version.js';
import { messageOf } from './errors.js';
import { isString } from './json.js';
import { loadConfig, readRawConfig, getPath, type Json, type X402Config } from './config.js';
import { resolveSigner } from './signers/index.js';
import { readBalances, type WalletBalances } from './rpc.js';
import { readRecords, spentToday, type LedgerRecord } from './ledger.js';
import { formatUnits, parseUnits } from './assets.js';
import type { SignerBackend } from './signer.js';
import { ethersAvailable, ETHERS_INSTALL_HINT } from './signers/local.js';

/**
 * "Where am I?" as data.
 *
 * `status` answers it without paying, signing or prompting, and `setup` runs the
 * same function to decide which steps it can skip. Both read the world through
 * `collectStatus`, so a step is "done" by one definition in one place.
 *
 * Nothing here may throw. A broken config, a signer that is down and an RPC that
 * is rate-limited are all facts about the machine, reported as fields: an agent
 * resuming a half-finished setup needs the report most exactly when something is
 * broken.
 */

/** The steps in order. These strings are also the H2 headings of `/skill.md`. */
export const STEPS = [
  'install',
  'create-wallet',
  'set-caps',
  'fund',
  'first-payment',
  'store-key',
  'ready',
] as const;
export type Step = (typeof STEPS)[number];

export const MIN_NODE = [20, 10, 0] as const;

/** The wallet balance setup waits for, and `fund` is judged against. */
export const DEFAULT_MIN_BALANCE = '1.00';

/** How long the funding step waits for a balance before giving up. */
export const DEFAULT_FUND_TIMEOUT = '30m';

/** The API environment variable a Roundhouse key is read from by convention. */
export const API_KEY_ENV = 'ROUNDHOUSE_API_KEY';

export type SignerPath = 'ows' | 'import' | 'generate' | 'other' | 'none';

export interface Status {
  cli: { version: string };
  node: { version: string; ok: boolean };
  signer: {
    /** How the key is held. `other` is an `exec` or third-party backend. */
    path: SignerPath;
    backend: string | null;
    wallet: string | null;
    address: string | null;
    typedData: boolean;
    /** `n/a` where the backend has no policy layer to speak of. */
    policy: 'active' | 'none' | 'n/a';
    /**
     * Whether the OWS policy key a policy-only wallet signs with is available in
     * this shell. `missing` means the wallet will refuse to sign: the key is shown
     * once at creation and lives in the environment, not in config.
     */
    policyKey: 'set' | 'missing' | 'n/a';
    error?: string;
  };
  balance: { usdc: string | null; chain: string; error?: string };
  limits: { maxPerCall: string; dailyCap: string };
  auth: {
    apiKey: 'set' | 'unset';
    /** Where a set key comes from. Never the value itself. */
    source?: 'env' | 'config';
  };
  telemetry: { enabled: boolean };
  spend: { today: string; calls: { today: number; total: number } };
  next: Step;
  /** Things that will bite later, none of which change `next`. */
  warnings: string[];
  config: { ok: boolean; error?: string };
}

/** The outside world, injectable so the tests never touch a network or a home dir. */
export interface StatusDeps {
  loadConfig: () => { config: X402Config };
  /** The file as written, `env:` references unresolved. */
  readRawConfig: () => Json;
  resolveSigner: (config: X402Config) => Promise<SignerBackend>;
  readBalances: (address: string, chain: string, config: X402Config) => Promise<WalletBalances>;
  readRecords: () => LedgerRecord[];
  env: NodeJS.ProcessEnv;
  /** Whether the optional `ethers` peer resolves, for the local backend. */
  ethersAvailable: () => Promise<boolean>;
  nodeVersion: string;
  now: number;
}

export interface StatusOptions {
  /** Decimal USDC `fund` is judged against. */
  minBalance?: string;
  deps?: Partial<StatusDeps>;
}

const defaultDeps = (): StatusDeps => ({
  loadConfig: () => loadConfig(),
  readRawConfig: () => readRawConfig(),
  resolveSigner: (config) => resolveSigner(config),
  readBalances: (address, chain, config) =>
    readBalances(address, chain, { rpc: config.rpc, symbol: 'usdc' }),
  readRecords: () => readRecords(),
  env: process.env,
  ethersAvailable,
  nodeVersion: process.versions.node,
  now: Date.now(),
});

/** `20.10.0` against the floor, numerically: `20.9` must not beat `20.10`. */
export function nodeMeetsMinimum(version: string): boolean {
  const parts = version
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < MIN_NODE.length; i++) {
    const have = parts[i] ?? 0;
    const need = MIN_NODE[i] ?? 0;
    if (Number.isNaN(have)) return false;
    if (have !== need) return have > need;
  }
  return true;
}

/** A money amount from config, as a string, or the literal `unset`. */
function amountOf(value: string | number | undefined): string {
  const text = String(value ?? '').trim();
  return text === '' ? 'unset' : text;
}

/** The `wallet.path` setup records, falling back to what the backend implies. */
function pathOf(config: X402Config): SignerPath {
  if (!config.wallet.default) return 'none';
  const recorded = getPath(config, 'wallet.path');
  if (recorded === 'ows' || recorded === 'import' || recorded === 'generate') return recorded;
  const backend = config.wallet.backend;
  if (backend === 'ows' || backend === 'ows-core') return 'ows';
  // A keystore written before `wallet.path` existed does not say whether it was
  // imported or generated, and guessing would put a false label on a custody
  // decision. `other` is the honest answer; `wallet create` records it going forward.
  return 'other';
}

/**
 * Whether a completed call to the Roundhouse key endpoint is on the local ledger.
 *
 * Completed means exit 0. A call that paid and got no valid response is exit 50
 * and its cached authorization makes a re-run safe and productive: it either
 * returns the key the first attempt missed or fails cleanly. Counting it as done
 * would send the next run to `store-key` with no key to store.
 */
function paidTestCall(records: LedgerRecord[]): boolean {
  return records.some(
    (r) => r.payment.paid && r.exitCode === 0 && /\/test\/x402\/?$/.test(r.url.split('?')[0] ?? ''),
  );
}

export interface StepFacts {
  nodeOk: boolean;
  signerReady: boolean;
  capsSet: boolean;
  /** Balance at or over the floor. False when it could not be read. */
  funded: boolean;
  /** Any payment at all on the ledger: money has already moved through this wallet. */
  everPaid: boolean;
  firstPaymentDone: boolean;
  apiKeySet: boolean;
}

/**
 * The first step that is not done.
 *
 * Funding is a precondition of the first payment and of nothing after it: once a
 * payment is on the ledger the wallet has demonstrably been funded, and a
 * balance that has since dropped under the floor is a spending fact, not an
 * unfinished setup. Without that rule a wallet that paid its first cent would
 * fall back to `fund` the moment it dropped under a dollar and never be `ready`.
 */
export function nextStep(f: StepFacts): Step {
  if (!f.nodeOk) return 'install';
  if (!f.signerReady) return 'create-wallet';
  if (!f.capsSet) return 'set-caps';
  if (!f.funded && !f.everPaid) return 'fund';
  if (!f.firstPaymentDone) return 'first-payment';
  if (!f.apiKeySet) return 'store-key';
  return 'ready';
}

export async function collectStatus(opts: StatusOptions = {}): Promise<Status> {
  const deps: StatusDeps = { ...defaultDeps(), ...opts.deps };
  const warnings: string[] = [];
  const minAtomic = parseUnits(opts.minBalance ?? DEFAULT_MIN_BALANCE, 6);

  const nodeOk = nodeMeetsMinimum(deps.nodeVersion);
  if (!nodeOk) {
    warnings.push(`Node ${deps.nodeVersion} is below the required ${MIN_NODE.join('.')}.`);
  }

  let config: X402Config | undefined;
  let configError: string | undefined;
  try {
    config = deps.loadConfig().config;
  } catch (err) {
    configError = messageOf(err);
    warnings.push(`config could not be read: ${configError}`);
  }

  // A config that cannot be read is reported and then read as empty, so every
  // step still gets an answer. Fall back to the shipped defaults rather than
  // inventing a second notion of "nothing configured".
  const effective: X402Config = config ?? loadConfigDefaults();

  const signer = await readSigner(effective, deps, warnings);
  const balance = await readBalance(effective, deps, signer.address);
  const records = readLedger(deps, warnings);

  const maxPerCall = amountOf(effective.limits.maxPerCall);
  const dailyCap = amountOf(effective.limits.dailyCap);

  const keyEnvironment = deps.env[API_KEY_ENV];
  const apiKeyValue = getPath(effective, 'auth.apiKey');
  const apiKeySet = isString(apiKeyValue) && apiKeyValue !== '';
  const keyRef = rawKeyReference(deps);
  if (!apiKeySet && keyRef) {
    warnings.push(
      `auth.apiKey points at ${keyRef} and ${keyRef.slice(4)} is not set in this shell. ` +
        `Export ${keyRef.slice(4)} with the key.`,
    );
  }

  const today = spentTodayDecimal(records, deps.now);
  const everPaid = records.some((r) => r.payment.paid);
  const funded = balance.atomic !== null && balance.atomic >= minAtomic;

  // A wallet that holds its key behind a policy and has no policy key in this
  // shell cannot sign, however healthy its address looks.
  const signerReady =
    signer.address !== null && signer.typedData && signer.report.policyKey !== 'missing';
  const facts: StepFacts = {
    nodeOk,
    signerReady,
    capsSet: maxPerCall !== 'unset' && dailyCap !== 'unset',
    funded,
    everPaid,
    firstPaymentDone:
      apiKeySet || (keyEnvironment !== undefined && keyEnvironment !== '') || paidTestCall(records),
    apiKeySet,
  };

  const balanceReport: Status['balance'] = {
    usdc: balance.amount,
    chain: effective.defaults.chain,
  };
  if (balance.error) balanceReport.error = balance.error;
  const auth: Status['auth'] = { apiKey: apiKeySet ? 'set' : 'unset' };
  if (apiKeySet) auth.source = keyRef ? 'env' : 'config';
  const configReport: Status['config'] = { ok: configError === undefined };
  if (configError) configReport.error = configError;

  return {
    cli: { version: VERSION },
    node: { version: deps.nodeVersion, ok: nodeOk },
    signer: signer.report,
    balance: balanceReport,
    limits: { maxPerCall, dailyCap },
    auth,
    telemetry: { enabled: effective.telemetry.sink.enabled === true },
    spend: {
      today: today.amount,
      calls: { today: today.calls, total: records.filter((r) => r.payment.paid).length },
    },
    next: nextStep(facts),
    warnings,
    config: configReport,
  };
}

/** Defaults without touching the disk, for a config file that would not load. */
function loadConfigDefaults(): X402Config {
  return loadConfig({ file: '/nonexistent/x402-defaults.json', cwd: '/nonexistent' }).config;
}

interface SignerReading {
  report: Status['signer'];
  address: string | null;
  typedData: boolean;
}

async function readSigner(
  config: X402Config,
  deps: StatusDeps,
  warnings: string[],
): Promise<SignerReading> {
  const path = pathOf(config);
  const backend = config.wallet.backend;
  const wallet = config.wallet.default ?? null;
  const base = { path, backend: wallet ? backend : null, wallet };

  if (!wallet) {
    return {
      report: {
        ...base,
        address: null,
        typedData: false,
        policy: 'n/a',
        policyKey: 'n/a',
        error: 'no wallet is configured (wallet.default is unset)',
      },
      address: null,
      typedData: false,
    };
  }

  let signer: SignerBackend;
  try {
    signer = await deps.resolveSigner(config);
  } catch (err) {
    // 47 for a signer that is missing, down or cannot sign typed data. Said as
    // a field: the caller wants to know it is the wallet layer, not that this
    // command failed.
    return {
      report: {
        ...base,
        address: null,
        typedData: false,
        policy: policyOf(config, false),
        policyKey: 'n/a',
        error: messageOf(err),
      },
      address: null,
      typedData: false,
    };
  }

  let typedData = false;
  let policyActive = false;
  try {
    const caps = await signer.capabilities();
    typedData = caps.typedData;
    policyActive = caps.policies;
  } catch (err) {
    return {
      report: {
        ...base,
        address: null,
        typedData: false,
        policy: policyOf(config, false),
        policyKey: 'n/a',
        error: messageOf(err),
      },
      address: null,
      typedData: false,
    };
  }

  let address: string | null = null;
  let error: string | undefined;
  try {
    address = await signer.getAddress();
  } catch (err) {
    error = messageOf(err);
  }

  const owsBacked = backend === 'ows' || backend === 'ows-core';
  const core = config.wallet.backends['ows-core'];
  const policyKeyMissing = owsBacked && core?.requireApiKey === true && !core.apiKey;
  if (policyKeyMissing) {
    warnings.push(
      'this wallet signs only with an OWS policy key and OWS_X402_KEY is not set in this ' +
        'shell. Export it, or mint a new one with `rh-x402 wallet policy`.',
    );
  }

  // The local keystore resolves its address without the passphrase or ethers;
  // only signing needs them. Said here, so the first paid call is not where an
  // operator learns the wallet cannot sign.
  if (backend === 'local') {
    const local = config.wallet.backends.local ?? {};
    if (!local.passphrase && !deps.env.X402_KEYSTORE_PASS) {
      warnings.push(
        'the local keystore cannot be unlocked in this shell: export X402_KEYSTORE_PASS, ' +
          'or set wallet.backends.local.passphrase to an env: reference. The first payment fails without it.',
      );
    }
    if (!(await deps.ethersAvailable())) {
      warnings.push(`the local backend cannot sign without \`ethers\`: ${ETHERS_INSTALL_HINT}`);
    }
  }

  const report: Status['signer'] = {
    ...base,
    address,
    typedData,
    policy: policyOf(config, policyActive),
    policyKey: policyKeyMissing ? 'missing' : core?.apiKey ? 'set' : 'n/a',
  };
  if (error) report.error = error;
  return { report, address, typedData };
}

function policyOf(config: X402Config, active: boolean): 'active' | 'none' | 'n/a' {
  const backend = config.wallet.backend;
  if (backend !== 'ows' && backend !== 'ows-core') return 'n/a';
  return active ? 'active' : 'none';
}

async function readBalance(
  config: X402Config,
  deps: StatusDeps,
  address: string | null,
): Promise<{ amount: string | null; atomic: bigint | null; error?: string }> {
  if (!address) return { amount: null, atomic: null };
  try {
    const result = await deps.readBalances(address, config.defaults.chain, config);
    const usdc = result.tokens.find((t) => t.symbol === 'usdc');
    if (!usdc) return { amount: null, atomic: null, error: 'no USDC contract known on this chain' };
    return { amount: usdc.amount, atomic: BigInt(usdc.atomic) };
  } catch (err) {
    return { amount: null, atomic: null, error: messageOf(err) };
  }
}

function readLedger(deps: StatusDeps, warnings: string[]): LedgerRecord[] {
  try {
    return deps.readRecords();
  } catch (err) {
    warnings.push(`the local ledger could not be read: ${messageOf(err)}`);
    return [];
  }
}

interface SpentToday {
  amount: string;
  calls: number;
}

function spentTodayDecimal(records: LedgerRecord[], now: number): SpentToday {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const calls = records.filter(
    (r) => r.payment.paid && Date.parse(r.ts) >= dayStart.getTime(),
  ).length;
  return { amount: formatUnits(spentToday(records, 'usdc', 6, now), 6), calls };
}

/**
 * The unresolved `auth.apiKey`, when it is an `env:` reference.
 *
 * `loadConfig` resolves references, so an unset variable comes back as
 * `undefined` and looks identical to "never configured". Reading the file as
 * written is what lets status name the variable that is missing.
 */
function rawKeyReference(deps: StatusDeps): string | undefined {
  try {
    const raw = getPath(deps.readRawConfig(), 'auth.apiKey');
    return isString(raw) && raw.startsWith('env:') ? raw : undefined;
  } catch {
    return undefined;
  }
}
