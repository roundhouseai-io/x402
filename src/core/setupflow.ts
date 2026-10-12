import { ExitCode, ExitCodeName, exitCodeOf, messageOf } from './errors.js';
import { parseUnits, formatUnits } from './assets.js';
import type { Json } from './config.js';
import { getPath } from './config.js';
import { API_KEY_ENV, MIN_NODE, nodeMeetsMinimum, type Status } from './status.js';
import type { SetupOptions, SetupResult } from './setup.js';
import type { WaitResult } from './fundwait.js';

/**
 * `rh-x402 setup`: from nothing to a stored API key, one command.
 *
 * Every step here is a thin decision around something that already exists as a
 * command (`wallet create`, `config set`, `wallet balance --wait`, `call`). The
 * flow adds only the order, the skipping, and the rule that makes it safe to run
 * twice: a step is skipped when `status` says it is done, and `status` is read
 * again after every step that changes the machine, so a kill at any point and a
 * re-run resumes at the step that did not finish.
 *
 * The world is injected (`FlowDeps`), so the whole flow, including a killed run
 * and a resumed one, is exercised in tests without a wallet, a network or a TTY.
 *
 * The step names are the `next` names `status` emits where one exists, so the
 * CLI and `/skill.md` share vocabulary.
 */

export type StepName =
  | 'environment'
  | 'state'
  | 'decisions'
  | 'create-wallet'
  | 'set-caps'
  | 'fund'
  | 'first-payment'
  | 'store-key'
  | 'summary';

export type StepResult = 'done' | 'skipped' | 'planned' | 'failed';

export interface StepEvent {
  step: StepName;
  result: StepResult;
  message: string;
  /** Step-specific fields, spread into the JSON object. Never carries the API key. */
  [field: string]: unknown;
}

export interface SetupFlags {
  path?: string | undefined;
  name?: string | undefined;
  vaultPath?: string | undefined;
  keyFile?: string | undefined;
  keystore?: string | undefined;
  expires?: string | undefined;
  maxPerCall?: string | undefined;
  dailyCap?: string | undefined;
  telemetry?: string | undefined;
  orgKey?: string | undefined;
  keyEnv?: string | undefined;
  minBalance: string;
  fundTimeoutMs: number;
  yes: boolean;
  dryRun: boolean;
  printKey: boolean;
  repay: boolean;
  install: boolean;
  policy?: boolean | undefined;
  replace: boolean;
}

/** One call to the proving endpoint, narrowed to what the flow reads. */
export interface TestCall {
  ok: boolean;
  paid: boolean;
  amount: string;
  asset?: string | undefined;
  receiptId: string;
  /** The paid response body. Read for `api_key` and never printed. */
  body?: unknown;
  /** What a dry run says it would pay. */
  selected?: { amount: string; assetSymbol: string; payTo: string; network: string } | undefined;
  errorCode?: number | undefined;
  error?: string | undefined;
}

export interface Prompts {
  ask(question: string, fallback?: string): Promise<string>;
  confirm(question: string, fallback?: boolean): Promise<boolean>;
  select<T>(
    question: string,
    choices: { value: T; label: string; detail?: string }[],
    fallback?: number,
  ): Promise<T>;
}

export interface FlowDeps {
  /** A person is at the terminal and can be asked. */
  interactive: boolean;
  env: NodeJS.ProcessEnv;
  /** `process.versions.node`, injectable so the too-old case is testable. */
  nodeVersion: string;
  /** Read-only report, re-run after every step that changes the machine. */
  status(minBalance: string): Promise<Status>;
  readRawConfig(): Json;
  writeConfig(entries: Record<string, string | boolean>): void;
  createWallet(opts: SetupOptions): Promise<SetupResult>;
  /** Whether `npm i -g` would work here. `undefined` when npm would not say. */
  globalInstallWritable(): boolean | undefined;
  /**
   * Mint a fresh OWS policy key for the configured wallet. For a wallet whose
   * key was shown once at creation and is no longer exported.
   */
  mintPolicyKey(): Promise<{ id: string; keyId: string; token: string }>;
  waitForFunds(input: {
    address: string;
    chain: string;
    minAtomic: bigint;
    timeoutMs: number;
  }): Promise<WaitResult>;
  /** The proving payment. `dryRun` runs every gate and stops before signing. */
  callTest(input: { dryRun: boolean; noCache: boolean; max: string }): Promise<TestCall>;
  /** Ask Roundhouse whether it recognises a key. `unknown` means it could not tell. */
  checkKey(key: string): Promise<'recognised' | 'rejected' | 'unknown'>;
  /** Machine-readable (`--json`) or human, decided by the caller. */
  emit(event: StepEvent): void;
  /** Progress and instructions. stderr, so stdout stays one clean stream. */
  say(line: string): void;
  prompts: Prompts;
  /** The proving endpoint, for the dry-run line. */
  testUrl: string;
}

/** What the operator decided, collected once and printed back before it is acted on. */
export interface Decisions {
  custody: 'existing' | 'ows' | 'import' | 'generate';
  maxPerCall: string;
  dailyCap: string;
  telemetry: 'on' | 'off';
  orgKey: string | null;
}

export const DEFAULT_MAX_PER_CALL = '0.05';
export const DEFAULT_DAILY_CAP = '5.00';
export const TEST_MAX = '0.02';

const ENV_REF = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

class StepFailure extends Error {
  constructor(
    readonly step: StepName,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const fail = (step: StepName, code: number, message: string): StepFailure =>
  new StepFailure(step, code, message);

function signerReady(s: Status): boolean {
  return s.signer.address !== null && s.signer.typedData && s.signer.policyKey !== 'missing';
}

/** The wallet is there and could sign, but the policy key it signs with is not exported here. */
function policyKeyLost(s: Status): boolean {
  return s.signer.address !== null && s.signer.typedData && s.signer.policyKey === 'missing';
}

/**
 * Run the setup. Returns the process exit code: 0, or the code of the first step
 * that failed. The failure is emitted as a `failed` event before returning.
 */
export async function runSetupFlow(flags: SetupFlags, deps: FlowDeps): Promise<number> {
  let current: StepName = 'environment';
  try {
    current = 'environment';
    environmentStep(deps);

    current = 'state';
    let status = await deps.status(flags.minBalance);
    deps.emit({
      step: 'state',
      result: 'done',
      message: `next step is ${status.next}`,
      next: status.next,
      report: status,
    });

    current = 'decisions';
    const decisions = await decide(flags, deps, status);
    deps.emit({
      step: 'decisions',
      result: 'done',
      message: describeDecisions(decisions),
      decisions,
    });

    current = 'create-wallet';
    await walletStep(flags, deps, status, decisions);
    status = flags.dryRun ? status : await deps.status(flags.minBalance);

    current = 'set-caps';
    applyCaps(flags, deps, decisions);
    status = flags.dryRun ? status : await deps.status(flags.minBalance);

    current = 'fund';
    await fundStep(flags, deps, status);
    status = flags.dryRun ? status : await deps.status(flags.minBalance);

    current = 'first-payment';
    const minted = await firstPaymentStep(flags, deps, status, decisions);

    current = 'store-key';
    await storeKeyStep(flags, deps, status, decisions, minted);
    status = flags.dryRun ? status : await deps.status(flags.minBalance);

    current = 'summary';
    return summaryStep(flags, deps, status);
  } catch (err) {
    const code = err instanceof StepFailure ? err.code : exitCodeOf(err);
    const step = err instanceof StepFailure ? err.step : current;
    deps.emit({
      step,
      result: 'failed',
      message: messageOf(err),
      errorCode: code,
      errorName: ExitCodeName[code] ?? 'error',
      // Re-running resumes here, because `status` is the only memory the flow has.
      resume: `Fix the cause and run \`rh-x402 setup\` again; it resumes at ${step}.`,
    });
    return code;
  }
}

function environmentStep(deps: FlowDeps): void {
  if (!nodeMeetsMinimum(deps.nodeVersion)) {
    throw fail(
      'environment',
      ExitCode.GENERIC,
      `Node ${deps.nodeVersion} is older than the ${MIN_NODE.join('.')} this CLI needs. Ask the operator to upgrade Node.`,
    );
  }
  const writable = deps.globalInstallWritable();
  const notes: string[] = [];
  if (writable === false) {
    notes.push(
      'npm i -g would fail here: the global npm directory is not writable. Do not use sudo; ' +
        'run `npx @roundhouseai/x402 <command>` or install into a project.',
    );
  }
  deps.emit({
    step: 'environment',
    result: 'done',
    message: `Node ${deps.nodeVersion}${notes.length > 0 ? `. ${notes.join(' ')}` : ''}`,
    node: deps.nodeVersion,
    globalInstallWritable: writable ?? null,
  });
}

function amountOrThrow(label: string, value: string): string {
  try {
    if (parseUnits(value, 6) <= 0n) throw new Error('must be above zero');
  } catch (err) {
    throw fail(
      'decisions',
      ExitCode.GENERIC,
      `${label} must be a positive decimal USDC amount, got "${value}" (${messageOf(err)})`,
    );
  }
  return value.trim();
}

/** Flag, then config, then a prompt or a default. Custody defaults to ows only with --yes. */
async function decide(flags: SetupFlags, deps: FlowDeps, status: Status): Promise<Decisions> {
  const raw = deps.readRawConfig();
  const missing: string[] = [];
  const canAsk = deps.interactive && !flags.yes;

  // Custody: where the money lives. A flag wins, then --yes (ows), then a prompt.
  let custody: Decisions['custody'];
  if (signerReady(status)) {
    custody = 'existing';
  } else if (flags.path !== undefined) {
    if (flags.path !== 'ows' && flags.path !== 'import' && flags.path !== 'generate') {
      throw fail(
        'decisions',
        ExitCode.GENERIC,
        `unknown --path ${flags.path}: expected ows, import or generate`,
      );
    }
    custody = flags.path;
  } else if (flags.yes) {
    // `--yes` is the agent's fast path. OWS is the custody this tool
    // recommends: the key never reaches this process and a policy sits in
    // front of every signature. `--yes` already consents to installing it.
    custody = 'ows';
  } else if (canAsk) {
    custody = await deps.prompts.select<'ows' | 'import' | 'generate'>(
      'How should this wallet hold its key?',
      [
        {
          value: 'ows',
          label: 'Open Wallet Standard  (recommended)',
          detail: 'The key stays encrypted in the OWS vault and is never handed to this CLI.',
        },
        {
          value: 'import',
          label: 'Import a private key you already have',
          detail: 'Read from a key file you place, into an encrypted keystore. Development and CI.',
        },
        {
          value: 'generate',
          label: 'Generate a key here  (not recommended)',
          detail: 'Same keystore, but the key is made by this tool. Throwaway wallets only.',
        },
      ],
      0,
    );
  } else {
    throw fail(
      'decisions',
      ExitCode.GENERIC,
      'no terminal to ask where the key is held: pass --path ows|import|generate, or --yes to use ows',
    );
  }

  const maxPerCall = await amountDecision(
    'limits.maxPerCall',
    '--max-per-call',
    flags.maxPerCall,
    status.limits.maxPerCall,
    DEFAULT_MAX_PER_CALL,
    'Most one call may cost, in USDC',
    flags,
    deps,
    canAsk,
    missing,
  );
  const dailyCap = await amountDecision(
    'limits.dailyCap',
    '--daily-cap',
    flags.dailyCap,
    status.limits.dailyCap,
    DEFAULT_DAILY_CAP,
    'Most this wallet may spend in a UTC day, in USDC',
    flags,
    deps,
    canAsk,
    missing,
  );

  let telemetry: Decisions['telemetry'];
  if (flags.telemetry !== undefined) {
    if (flags.telemetry !== 'on' && flags.telemetry !== 'off') {
      throw fail(
        'decisions',
        ExitCode.GENERIC,
        `--telemetry must be on or off, got ${flags.telemetry}`,
      );
    }
    telemetry = flags.telemetry;
  } else if (getPath(raw, 'telemetry.sink.enabled') !== undefined) {
    telemetry = getPath(raw, 'telemetry.sink.enabled') === true ? 'on' : 'off';
  } else {
    // Not asked: the sink is on by default and opting out is a flag, a config
    // key or DO_NOT_TRACK=1. What the effective config says is what setup keeps.
    telemetry = status.telemetry.enabled ? 'on' : 'off';
  }

  let orgKey: string | null = null;
  if (flags.orgKey !== undefined) {
    if (!ENV_REF.test(flags.orgKey)) {
      throw fail(
        'decisions',
        ExitCode.GENERIC,
        `--org-key takes an environment reference such as env:ROUNDHOUSE_API_KEY, not the key itself (got "${flags.orgKey.slice(0, 4)}...")`,
      );
    }
    orgKey = flags.orgKey;
  } else if (status.auth.apiKey === 'set') {
    orgKey = null;
  } else if (canAsk) {
    if (
      await deps.prompts.confirm(
        'Use an existing Roundhouse organization key instead of paying $0.01 for a test key?',
        false,
      )
    ) {
      const name = await deps.prompts.ask('Environment variable that holds it', API_KEY_ENV);
      orgKey = `env:${name}`;
      if (!ENV_REF.test(orgKey)) {
        throw fail(
          'decisions',
          ExitCode.GENERIC,
          `"${name}" is not a valid environment variable name`,
        );
      }
    }
  }

  if (missing.length > 0) {
    throw fail(
      'decisions',
      ExitCode.GENERIC,
      `no terminal to ask on and some decisions are not made. Pass ${missing.join(', ')}, or --yes to accept the defaults for everything but where the key is held`,
    );
  }

  return { custody, maxPerCall, dailyCap, telemetry, orgKey };
}

async function amountDecision(
  _key: string,
  flagName: string,
  flagValue: string | undefined,
  configured: string,
  fallback: string,
  question: string,
  flags: SetupFlags,
  deps: FlowDeps,
  canAsk: boolean,
  missing: string[],
): Promise<string> {
  if (flagValue !== undefined) return amountOrThrow(flagName, flagValue);
  if (configured !== 'unset') return configured;
  if (canAsk) return amountOrThrow(flagName, await deps.prompts.ask(question, fallback));
  if (flags.yes) return fallback;
  missing.push(`${flagName} <usdc>`);
  return fallback;
}

function describeDecisions(d: Decisions): string {
  const custody = d.custody === 'existing' ? 'existing wallet kept' : `key held by ${d.custody}`;
  return (
    `${custody}; max per call ${d.maxPerCall} USDC; daily cap ${d.dailyCap} USDC; ` +
    `telemetry ${d.telemetry}; ${d.orgKey ? `org key from ${d.orgKey.slice(4)}` : 'test key by payment'}`
  );
}

/**
 * The wallet exists and is funded or fundable, but OWS_X402_KEY is not exported:
 * the usual state of a second run in a new shell, since OWS shows the key once.
 * Minting another is what `rh-x402 wallet policy` does, and doing it here is what
 * makes a re-run resume instead of stopping on a token nobody can recover. The
 * wallet and its funds are untouched; only a new key bound to the same policy is made.
 */
async function mintLostPolicyKey(flags: SetupFlags, deps: FlowDeps, status: Status): Promise<void> {
  if (flags.dryRun) {
    deps.emit({
      step: 'create-wallet',
      result: 'planned',
      message: `would mint a new OWS policy key for ${status.signer.wallet ?? 'the wallet'}: OWS_X402_KEY is not set in this shell`,
    });
    return;
  }
  let grant: { id: string; keyId: string; token: string };
  try {
    grant = await deps.mintPolicyKey();
  } catch (err) {
    throw fail('create-wallet', exitCodeOf(err), messageOf(err));
  }
  deps.env.OWS_X402_KEY = grant.token;
  deps.emit({
    step: 'create-wallet',
    result: 'done',
    message: `wallet ${status.signer.wallet ?? ''} kept; OWS_X402_KEY was not set in this shell, so a new policy key was minted for it`,
    address: status.signer.address,
    policy: {
      id: grant.id,
      keyId: grant.keyId,
      token: grant.token,
      export: `export OWS_X402_KEY=${grant.token}`,
    },
  });
  deps.say(
    `save this now, OWS shows it once: export OWS_X402_KEY=${grant.token}  ` +
      '(every shell that pays needs it; without it the wallet refuses to sign)',
  );
}

async function walletStep(
  flags: SetupFlags,
  deps: FlowDeps,
  status: Status,
  decisions: Decisions,
): Promise<void> {
  if (signerReady(status)) {
    deps.emit({
      step: 'create-wallet',
      result: 'skipped',
      message: `wallet ${status.signer.wallet ?? ''} already signs typed data at ${status.signer.address}; setup never replaces a wallet`,
      address: status.signer.address,
    });
    return;
  }
  if (policyKeyLost(status)) {
    await mintLostPolicyKey(flags, deps, status);
    return;
  }
  if (flags.dryRun) {
    deps.emit({
      step: 'create-wallet',
      result: 'planned',
      message: `would create a wallet held by ${decisions.custody}`,
      custody: decisions.custody,
    });
    return;
  }

  // `--yes` is consent to what the defaults need: installing the OWS bindings
  // and taking the policy. Without it, `wallet create` asks, or refuses.
  const opts: SetupOptions = {
    path: decisions.custody,
    install: flags.install || flags.yes,
    replace: flags.replace,
    ...(flags.name ? { name: flags.name } : {}),
    ...(flags.vaultPath ? { vaultPath: flags.vaultPath } : {}),
    ...(flags.keyFile ? { keyFile: flags.keyFile } : {}),
    ...(flags.keystore ? { keystore: flags.keystore } : {}),
    ...(flags.expires ? { expires: flags.expires } : {}),
    ...(flags.policy !== undefined ? { policy: flags.policy } : flags.yes ? { policy: true } : {}),
  };

  let result: SetupResult;
  try {
    result = await deps.createWallet(opts);
  } catch (err) {
    throw fail('create-wallet', exitCodeOf(err), messageOf(err));
  }

  // The policy key is shown once and lives in this process only until the
  // operator exports it. Setting it here is what lets the payment in this same
  // run sign through the policy rather than falling back to owner access.
  if (result.policy) deps.env.OWS_X402_KEY = result.policy.token;

  deps.emit({
    step: 'create-wallet',
    result: 'done',
    message: `wallet ${result.wallet} on the ${result.backend} backend at ${result.address}`,
    wallet: result.wallet,
    address: result.address,
    backend: result.backend,
    configured: result.configured,
    ...(result.policy
      ? {
          policy: {
            id: result.policy.id,
            keyId: result.policy.keyId,
            // Shown once by OWS and never recoverable. The operator must export it
            // in every shell that will pay, or the wallet will refuse to sign.
            token: result.policy.token,
            export: `export OWS_X402_KEY=${result.policy.token}`,
          },
        }
      : {}),
    nextSteps: result.nextSteps,
  });
  if (result.policy) {
    deps.say(
      `save this now, OWS shows it once: export OWS_X402_KEY=${result.policy.token}  ` +
        '(every shell that pays needs it; without it the wallet refuses to sign)',
    );
  }
}

function applyCaps(flags: SetupFlags, deps: FlowDeps, d: Decisions): void {
  const raw = deps.readRawConfig();
  const entries: Record<string, string | boolean> = {};
  const want: [string, string | boolean][] = [
    ['limits.maxPerCall', d.maxPerCall],
    ['limits.dailyCap', d.dailyCap],
    ['telemetry.sink.enabled', d.telemetry === 'on'],
  ];
  for (const [key, value] of want) {
    if (getPath(raw, key) !== value) entries[key] = value;
  }

  const advisory =
    'These caps are advisory: this CLI computes them from a local ledger and the wallet policy ' +
    'bounds what may be signed, never how much. The balance is the real limit.';

  if (Object.keys(entries).length === 0) {
    deps.emit({
      step: 'set-caps',
      result: 'skipped',
      message: `caps already set (${d.maxPerCall} per call, ${d.dailyCap} a day, telemetry ${d.telemetry})`,
    });
    return;
  }
  if (flags.dryRun) {
    deps.emit({
      step: 'set-caps',
      result: 'planned',
      message: `would write ${Object.keys(entries).join(', ')}. ${advisory}`,
      wouldWrite: Object.keys(entries),
    });
    return;
  }
  deps.writeConfig(entries);
  deps.emit({
    step: 'set-caps',
    result: 'done',
    message: `${d.maxPerCall} per call, ${d.dailyCap} a day, telemetry ${d.telemetry}. ${advisory}`,
    wrote: Object.keys(entries),
  });
}

async function fundStep(flags: SetupFlags, deps: FlowDeps, status: Status): Promise<void> {
  const min = parseUnits(flags.minBalance, 6);
  const funded = status.balance.usdc !== null && parseUnits(status.balance.usdc, 6) >= min;
  // Funding gates the first payment and nothing after it: a wallet that has
  // already paid has been funded, whatever it holds now.
  const everPaid = status.spend.calls.total > 0;

  if (funded || everPaid) {
    deps.emit({
      step: 'fund',
      result: 'skipped',
      message: `already funded: ${status.balance.usdc ?? 'unknown'} USDC on ${status.balance.chain}`,
      balance: status.balance.usdc,
      address: status.signer.address,
    });
    return;
  }

  const address = status.signer.address;
  if (!address) {
    // Only reachable in a dry run, where the wallet has not been made.
    deps.emit({
      step: 'fund',
      result: 'planned',
      message: `would print the new wallet's address and wait for ${formatUnits(min, 6)} USDC on ${status.balance.chain}`,
    });
    return;
  }

  const chain = status.balance.chain;
  deps.say(
    `fund ${address} with USDC on Base (chain 8453, ${chain}). No ETH is needed, the facilitator pays the gas. ` +
      'A first load of 2 to 5 USDC is hundreds of calls at typical prices. Pick Base on the withdrawal screen.',
  );
  deps.say(
    'while you wait: run `rh-x402 discover <capability> --policy` and `rh-x402 probe <endpoint>` on the ' +
      'endpoints you actually need, and report an estimated spend. Neither pays.',
  );

  if (flags.dryRun) {
    deps.emit({
      step: 'fund',
      result: 'planned',
      message: `would wait up to ${Math.round(flags.fundTimeoutMs / 60000)}m for ${formatUnits(min, 6)} USDC at ${address}`,
      address,
    });
    return;
  }

  const waited = await deps.waitForFunds({
    address,
    chain,
    minAtomic: min,
    timeoutMs: flags.fundTimeoutMs,
  });
  if (!waited.met) {
    throw fail(
      'fund',
      ExitCode.WAIT_TIMEOUT,
      `timed out waiting for ${formatUnits(min, 6)} USDC at ${address} on ${chain}` +
        (waited.amount === null
          ? '; the balance could not be read'
          : `; it holds ${waited.amount}`) +
        (waited.lastError ? ` (last read error: ${waited.lastError})` : ''),
    );
  }
  deps.emit({
    step: 'fund',
    result: 'done',
    message: `${waited.amount} USDC at ${address} on ${chain}`,
    address,
    balance: waited.amount,
    waitedMs: waited.elapsedMs,
  });
}

/** The key a paid test call returned, held in memory for exactly as long as it takes to store it. */
interface Minted {
  key: string;
}

function apiKeyOf(body: unknown): string | undefined {
  const holder = body as { api_key?: unknown } | null | undefined;
  const key = holder?.api_key;
  return typeof key === 'string' && key !== '' ? key : undefined;
}

async function firstPaymentStep(
  flags: SetupFlags,
  deps: FlowDeps,
  status: Status,
  decisions: Decisions,
): Promise<Minted | undefined> {
  if (decisions.orgKey) {
    deps.emit({
      step: 'first-payment',
      result: 'skipped',
      message: `using the organization key in ${decisions.orgKey.slice(4)}; no test payment needed`,
    });
    return undefined;
  }
  if (status.auth.apiKey === 'set') {
    deps.emit({
      step: 'first-payment',
      result: 'skipped',
      message: 'an API key is already set',
    });
    return undefined;
  }
  const envKey = deps.env[API_KEY_ENV];
  if (envKey) {
    deps.emit({
      step: 'first-payment',
      result: 'skipped',
      message: `${API_KEY_ENV} is already exported; no test payment needed`,
    });
    return undefined;
  }
  // A settled test payment is on the ledger but no key was kept. The key is
  // returned once, so the payment cannot be recovered: say so, and make the
  // second one an explicit choice rather than a quiet retry.
  if (status.next === 'store-key' && !flags.repay) return undefined;

  // A dry run before a wallet exists has nothing to sign with, so it cannot
  // exercise the gates. Say what would happen rather than failing on a wallet
  // this run was told not to make.
  if (flags.dryRun && status.signer.address === null) {
    deps.emit({
      step: 'first-payment',
      result: 'planned',
      message: `would dry-run, then pay, the test endpoint ${deps.testUrl} with --max ${TEST_MAX}`,
    });
    return undefined;
  }

  const max = TEST_MAX;
  const dry = await deps.callTest({ dryRun: true, noCache: false, max });
  if (!dry.ok) {
    throw fail(
      'first-payment',
      dry.errorCode ?? ExitCode.GENERIC,
      `the dry run was refused: ${dry.error ?? 'unknown error'}`,
    );
  }
  const would = dry.selected;
  deps.emit({
    step: 'first-payment',
    result: 'planned',
    message: would
      ? `dry run passed every gate: would pay ${would.amount} ${would.assetSymbol} to ${would.payTo} on ${would.network} at ${deps.testUrl}`
      : `dry run passed every gate at ${deps.testUrl}`,
    dryRun: true,
    ...(would ? { selected: would } : {}),
  });
  if (flags.dryRun) return undefined;

  const result = await deps.callTest({ dryRun: false, noCache: flags.repay, max });
  if (!result.ok) {
    throw fail(
      'first-payment',
      result.errorCode ?? ExitCode.GENERIC,
      `${result.error ?? 'the test payment failed'}` +
        (result.errorCode === ExitCode.PAID_NO_RESPONSE
          ? '. Money may have moved. Re-run `rh-x402 setup`: the cached authorization makes the retry safe.'
          : ''),
    );
  }
  const key = apiKeyOf(result.body);
  if (!key) {
    throw fail(
      'first-payment',
      ExitCode.GENERIC,
      `the payment settled (receipt ${result.receiptId}) but the response carried no api_key. Nothing was stored.`,
    );
  }
  deps.emit({
    step: 'first-payment',
    result: 'done',
    message: `paid ${result.amount} ${result.asset ?? 'usdc'}, receipt ${result.receiptId}`,
    amount: result.amount,
    receiptId: result.receiptId,
  });
  return { key };
}

async function storeKeyStep(
  flags: SetupFlags,
  deps: FlowDeps,
  status: Status,
  decisions: Decisions,
  minted: Minted | undefined,
): Promise<void> {
  // 1. A key we just bought. Written before anything else is printed: it is
  //    returned once, and a kill between here and the write loses it.
  if (minted) {
    if (flags.keyEnv) {
      if (!ENV_REF.test(`env:${flags.keyEnv}`)) {
        throw fail(
          'store-key',
          ExitCode.GENERIC,
          `"${flags.keyEnv}" is not a valid environment variable name`,
        );
      }
      deps.writeConfig({ 'auth.apiKey': `env:${flags.keyEnv}` });
      deps.emit({
        step: 'store-key',
        result: 'done',
        message:
          `auth.apiKey points at ${flags.keyEnv}. The key is shown once; export it in every shell that calls Roundhouse: ` +
          `export ${flags.keyEnv}=<key>`,
        source: 'env',
        env: flags.keyEnv,
        apiKey: minted.key,
        export: `export ${flags.keyEnv}=${minted.key}`,
      });
      return;
    }
    deps.writeConfig({ 'auth.apiKey': minted.key });
    deps.emit({
      step: 'store-key',
      result: 'done',
      message:
        'stored as auth.apiKey in ~/.x402/config.json (mode 0600). It is not shown. ' +
        '`--print-key` shows it once, and `--key-env NAME` keeps it in the environment instead.',
      source: 'config',
      ...(flags.printKey ? { apiKey: minted.key } : {}),
    });
    return;
  }

  // 2. An organization key the operator already holds, by reference.
  if (decisions.orgKey) {
    const name = decisions.orgKey.slice(4);
    // Already stored, and resolving: a second run changes nothing and asks
    // Roundhouse nothing.
    if (
      status.auth.apiKey === 'set' &&
      getPath(deps.readRawConfig(), 'auth.apiKey') === decisions.orgKey
    ) {
      deps.emit({
        step: 'store-key',
        result: 'skipped',
        message: `auth.apiKey already points at ${name}`,
        source: 'env',
        env: name,
      });
      return;
    }
    if (!flags.dryRun) deps.writeConfig({ 'auth.apiKey': decisions.orgKey });
    const value = deps.env[name];
    if (!value) {
      throw fail(
        'store-key',
        ExitCode.GENERIC,
        `auth.apiKey points at ${name} but ${name} is not set in this shell. Export it with the key, then run \`rh-x402 setup\` again.`,
      );
    }
    const verdict = await deps.checkKey(value);
    if (verdict === 'rejected') {
      throw fail(
        'store-key',
        ExitCode.GENERIC,
        `Roundhouse does not recognise the key in ${name}. Check it is an active organization key from the dashboard.`,
      );
    }
    deps.emit({
      step: 'store-key',
      result: flags.dryRun ? 'planned' : 'done',
      message:
        `auth.apiKey points at ${name}` +
        (verdict === 'recognised'
          ? ' and Roundhouse recognises the key'
          : ' (Roundhouse could not be reached to confirm it)'),
      source: 'env',
      env: name,
      verified: verdict,
    });
    return;
  }

  // 3. Already done.
  if (status.auth.apiKey === 'set') {
    deps.emit({
      step: 'store-key',
      result: 'skipped',
      message: `auth.apiKey is already set (${status.auth.source ?? 'config'})`,
    });
    return;
  }

  // 4. A key already exported but not referenced from config.
  const envKey = deps.env[API_KEY_ENV];
  if (envKey) {
    if (!flags.dryRun) deps.writeConfig({ 'auth.apiKey': `env:${API_KEY_ENV}` });
    deps.emit({
      step: 'store-key',
      result: flags.dryRun ? 'planned' : 'done',
      message: `auth.apiKey points at ${API_KEY_ENV}, which is exported in this shell`,
      source: 'env',
      env: API_KEY_ENV,
    });
    return;
  }

  if (flags.dryRun) {
    deps.emit({
      step: 'store-key',
      result: 'planned',
      message: 'would store the key the test payment returns as auth.apiKey',
    });
    return;
  }

  // 5. A test payment settled earlier and its key was never kept.
  throw fail(
    'store-key',
    ExitCode.GENERIC,
    'a test payment is on the ledger but no key was stored. The key is returned exactly once and cannot be recovered. ' +
      'Run `rh-x402 setup --repay` to pay another $0.01 for a new one, or export an organization key as ' +
      `${API_KEY_ENV} and run \`rh-x402 setup\` again.`,
  );
}

const NEXT_COMMANDS = [
  'rh-x402 discover <capability> --policy      # who sells it, and is the price sane',
  'rh-x402 probe <endpoint>                    # its live price; never pays',
  'rh-x402 call <endpoint> --max <price>       # pay it, within a cap',
];

function summaryStep(flags: SetupFlags, deps: FlowDeps, status: Status): number {
  if (flags.dryRun) {
    deps.emit({
      step: 'summary',
      result: 'planned',
      message: 'dry run: no wallet was made, no config was written and nothing was paid',
      next: status.next,
      report: status,
      commands: NEXT_COMMANDS,
    });
    return ExitCode.OK;
  }
  const ready = status.next === 'ready';
  deps.emit({
    step: 'summary',
    result: ready ? 'done' : 'failed',
    message: ready
      ? 'ready'
      : `every step ran but status still says next: ${status.next}. ${status.warnings.join(' ')}`.trim(),
    next: status.next,
    report: status,
    commands: NEXT_COMMANDS,
  });
  return ready ? ExitCode.OK : ExitCode.GENERIC;
}
