import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONFIG,
  getPath,
  mergeDeep,
  resolveEnv,
  setPath,
  type Json,
  type X402Config,
} from '../src/core/config.js';
import { ExitCode } from '../src/core/errors.js';
import { collectStatus } from '../src/core/status.js';
import {
  runSetupFlow,
  type FlowDeps,
  type SetupFlags,
  type StepEvent,
  type TestCall,
} from '../src/core/setupflow.js';
import type { SetupResult } from '../src/core/setup.js';
import type { LedgerRecord } from '../src/core/ledger.js';
import type { SignerBackend } from '../src/core/signer.js';
import type { WalletBalances } from '../src/core/rpc.js';

const ADDRESS = '0x2D43136FfBbbe0ED5CBaaB2E8B2b8c968059114C';
const MINTED_KEY = 'rh_live_mintedsecret0123456789';
const POLICY_TOKEN = 'ows_key_policytoken0123456789';
const TEST_URL = 'https://api.roundhouseai.io/v0/test/x402';

/**
 * A small stand-in for the machine: a config file, an OWS vault, a chain and a
 * ledger. `status` is the REAL `collectStatus` reading it, so the flow and the
 * report that decides which steps to skip are tested together.
 */
class World {
  raw: Json = {};
  env: NodeJS.ProcessEnv = {};
  walletExists = false;
  balance = 0n;
  ledger: LedgerRecord[] = [];
  writes = 0;
  walletsCreated = 0;
  keysMinted = 0;
  payments: { dryRun: boolean; noCache: boolean }[] = [];
  said: string[] = [];
  events: StepEvent[] = [];
  /** What the funder does while setup waits. */
  fundWith: bigint | 'never' = 1_000_000n;
  /** One-shot faults, consumed when they fire. */
  fault: { at: string; error?: Error; result?: Partial<TestCall> } | undefined;
  interactive = false;
  nodeVersion = '22.1.0';
  answers: { select?: string; ask?: string[]; confirm?: boolean[] } = {};
  keyRecognised: 'recognised' | 'rejected' | 'unknown' = 'recognised';

  config(): X402Config {
    return resolveEnv(mergeDeep(DEFAULT_CONFIG, this.raw), this.env);
  }

  private tripped(at: string): Error | undefined {
    if (this.fault?.at !== at) return undefined;
    const error = this.fault.error ?? new Error(`killed at ${at}`);
    this.fault = undefined;
    return error;
  }

  deps(): FlowDeps {
    const world = this;
    const signer = (): SignerBackend => ({
      backend: 'ows-core',
      wallet: 'x402-agent',
      capabilities: async () => ({
        typedData: true,
        policies: true,
        balances: false,
        accounts: true,
        declared: true,
      }),
      getAccounts: async () => [],
      getAddress: async () => ADDRESS,
      signTypedData: async () => '0x',
    });
    const balances = (): WalletBalances => ({
      address: ADDRESS,
      chain: 'base',
      chainId: 8453,
      rpcUrl: 'x',
      native: { symbol: 'ETH', amount: '0', atomic: '0', decimals: 18 },
      tokens: [
        {
          symbol: 'usdc',
          amount: (Number(world.balance) / 1e6).toString(),
          atomic: world.balance.toString(),
          decimals: 6,
        },
      ],
      canPayX402: world.balance > 0n,
    });

    return {
      get interactive() {
        return world.interactive;
      },
      env: world.env,
      nodeVersion: world.nodeVersion,
      status: (minBalance) =>
        collectStatus({
          minBalance,
          deps: {
            loadConfig: () => ({ config: world.config() }),
            readRawConfig: () => world.raw,
            resolveSigner: async () => {
              if (!world.walletExists) throw new Error('no wallet');
              return signer();
            },
            readBalances: async () => balances(),
            readRecords: () => world.ledger,
            env: world.env,
            nodeVersion: '22.1.0',
            now: Date.parse('2026-10-02T12:00:00Z'),
          },
        }),
      readRawConfig: () => world.raw,
      writeConfig: (entries) => {
        world.writes++;
        for (const [key, value] of Object.entries(entries)) setPath(world.raw, key, value);
      },
      createWallet: async (opts) => {
        const fault = world.tripped('createWallet');
        if (fault) throw fault;
        world.walletsCreated++;
        world.walletExists = true;
        world.raw = setPath(world.raw, 'wallet.backend', 'ows-core');
        world.raw = setPath(world.raw, 'wallet.default', 'x402-agent');
        world.raw = setPath(world.raw, 'wallet.path', opts.path ?? 'ows');
        if (opts.policy) {
          // What the real wallet setup writes: a reference to a key that lives in
          // the environment, and a refusal to sign without it.
          world.raw = setPath(world.raw, 'wallet.backends.ows-core.apiKey', 'env:OWS_X402_KEY');
          world.raw = setPath(world.raw, 'wallet.backends.ows-core.requireApiKey', true);
        }
        const result: SetupResult = {
          path: 'ows',
          backend: 'ows-core',
          wallet: 'x402-agent',
          address: ADDRESS,
          configured: {},
          nextSteps: [],
          ...(opts.policy ? { policy: { id: 'pol', keyId: 'key', token: POLICY_TOKEN } } : {}),
        };
        return result;
      },
      globalInstallWritable: () => true,
      mintPolicyKey: async () => {
        world.keysMinted++;
        return {
          id: 'pol',
          keyId: `key${world.keysMinted}`,
          token: `${POLICY_TOKEN}_${world.keysMinted}`,
        };
      },
      waitForFunds: async ({ minAtomic }) => {
        const fault = world.tripped('waitForFunds');
        if (fault) throw fault;
        if (world.fundWith === 'never') {
          return { met: false, amount: '0', polls: 3, elapsedMs: 1800000 };
        }
        world.balance = world.fundWith;
        return {
          met: world.balance >= minAtomic,
          amount: (Number(world.balance) / 1e6).toString(),
          polls: 2,
          elapsedMs: 20_000,
        };
      },
      callTest: async ({ dryRun, noCache }) => {
        world.payments.push({ dryRun, noCache });
        const fault = world.tripped(dryRun ? 'dryRun' : 'pay');
        if (fault) throw fault;
        if (dryRun) {
          return {
            ok: true,
            paid: false,
            amount: '0',
            receiptId: '',
            selected: {
              amount: '0.01',
              assetSymbol: 'usdc',
              payTo: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd',
              network: 'base',
            },
          };
        }
        const record = (exitCode: number): LedgerRecord => ({
          id: `r${world.ledger.length}`,
          ts: '2026-10-02T11:00:00Z',
          url: TEST_URL,
          method: 'GET',
          wallet: 'x402-agent',
          request: { bytes: 0 },
          payment: { paid: true, amount: '0.01', asset: 'usdc' },
          response: { status: exitCode === 0 ? 200 : null, bytes: 0, latencyMs: 1 },
          exitCode,
          agent: {},
        });
        if (world.fault?.at === 'payLostResponse') {
          world.fault = undefined;
          world.balance -= 10_000n;
          world.ledger.push(record(50));
          return {
            ok: false,
            paid: true,
            amount: '0.01',
            receiptId: 'r-lost',
            errorCode: ExitCode.PAID_NO_RESPONSE,
            error: 'no valid response',
          };
        }
        // A retry of a paid-no-response call reuses the cached authorization:
        // it returns the key without a second payment.
        const retryOfLost = world.ledger.some((r) => r.exitCode === 50);
        if (!retryOfLost && !noCache) world.balance -= 10_000n;
        else if (noCache) world.balance -= 10_000n;
        world.ledger.push(record(0));
        return {
          ok: true,
          paid: true,
          amount: '0.01',
          asset: 'usdc',
          receiptId: 'r-ok',
          body: { api_key: MINTED_KEY, expires_at: '2026-11-01' },
        };
      },
      checkKey: async () => world.keyRecognised,
      emit: (event) => {
        world.events.push(event);
      },
      say: (line) => {
        world.said.push(line);
      },
      prompts: {
        ask: async (_q, fallback) => world.answers.ask?.shift() ?? fallback ?? '',
        confirm: async (_q, fallback) => world.answers.confirm?.shift() ?? fallback ?? false,
        select: async <T>() => world.answers.select as T,
      },
      testUrl: TEST_URL,
    };
  }

  stepResults(): string[] {
    return this.events.map((e) => `${e.step}:${e.result}`);
  }

  result(step: string): StepEvent | undefined {
    return this.events.find((e) => e.step === step);
  }

  reset(): void {
    this.events = [];
    this.said = [];
  }
}

const ACCEPTANCE: SetupFlags = {
  path: 'ows',
  maxPerCall: '0.05',
  dailyCap: '5',
  telemetry: 'off',
  minBalance: '1.00',
  fundTimeoutMs: 1_800_000,
  yes: true,
  dryRun: false,
  printKey: false,
  repay: false,
  install: false,
  replace: false,
};

const run = (world: World, flags: Partial<SetupFlags> = {}) =>
  runSetupFlow({ ...ACCEPTANCE, ...flags }, world.deps());

describe('setup on a clean machine', () => {
  it('goes from nothing to ready with only the documented flags', async () => {
    const world = new World();
    expect(await run(world)).toBe(ExitCode.OK);

    expect(world.stepResults()).toEqual([
      'environment:done',
      'state:done',
      'decisions:done',
      'create-wallet:done',
      'set-caps:done',
      'fund:done',
      'first-payment:planned',
      'first-payment:done',
      'store-key:done',
      'summary:done',
    ]);
    expect(world.walletsCreated).toBe(1);
    expect(getPath(world.raw, 'limits.maxPerCall')).toBe('0.05');
    expect(getPath(world.raw, 'limits.dailyCap')).toBe('5');
    expect(getPath(world.raw, 'telemetry.sink.enabled')).toBe(false);
    expect(getPath(world.raw, 'auth.apiKey')).toBe(MINTED_KEY);
    expect(world.result('summary')?.next).toBe('ready');
  });

  it('dry-runs the payment before making it, and pays exactly once', async () => {
    const world = new World();
    await run(world);
    expect(world.payments).toEqual([
      { dryRun: true, noCache: false },
      { dryRun: false, noCache: false },
    ]);
  });

  it('takes the OWS policy and the install by default under --yes, and says what the policy cannot do', async () => {
    const world = new World();
    await run(world);
    const created = world.result('create-wallet');
    expect(created?.policy).toMatchObject({ id: 'pol', token: POLICY_TOKEN });
    // Exported into this process so the payment in this run signs through the policy.
    expect(world.env.OWS_X402_KEY).toBe(POLICY_TOKEN);
    expect(world.said.join('\n')).toContain('export OWS_X402_KEY=');
    expect(world.result('set-caps')?.message).toContain('advisory');
    expect(world.result('set-caps')?.message).toContain('balance is the real limit');
  });

  it('never carries the API key in any event unless it was asked for', async () => {
    const world = new World();
    await run(world);
    expect(JSON.stringify(world.events)).not.toContain(MINTED_KEY);
    expect(world.said.join('\n')).not.toContain(MINTED_KEY);
  });

  it('shows the key once with --print-key, and only in the store-key event', async () => {
    const world = new World();
    await run(world, { printKey: true });
    expect(world.result('store-key')?.apiKey).toBe(MINTED_KEY);
    const others = world.events.filter((e) => e.step !== 'store-key');
    expect(JSON.stringify(others)).not.toContain(MINTED_KEY);
  });

  it('keeps the key in the environment with --key-env, and says how to export it', async () => {
    const world = new World();
    await run(world, { keyEnv: 'MY_RH_KEY' });
    expect(getPath(world.raw, 'auth.apiKey')).toBe('env:MY_RH_KEY');
    expect(JSON.stringify(world.raw)).not.toContain(MINTED_KEY);
    expect(world.result('store-key')?.export).toBe(`export MY_RH_KEY=${MINTED_KEY}`);
  });
});

describe('running it again', () => {
  it('changes nothing, pays nothing and exits 0 with next: ready', async () => {
    const world = new World();
    await run(world);
    const writes = world.writes;
    const payments = world.payments.length;
    const raw = JSON.stringify(world.raw);
    world.reset();

    expect(await run(world)).toBe(ExitCode.OK);
    expect(world.writes).toBe(writes);
    expect(world.payments.length).toBe(payments);
    expect(JSON.stringify(world.raw)).toBe(raw);
    expect(world.walletsCreated).toBe(1);
    expect(world.stepResults()).toEqual([
      'environment:done',
      'state:done',
      'decisions:done',
      'create-wallet:skipped',
      'set-caps:skipped',
      'fund:skipped',
      'first-payment:skipped',
      'store-key:skipped',
      'summary:done',
    ]);
    expect(world.result('summary')?.next).toBe('ready');
  });

  it('in a new shell where the policy key is no longer exported, mints a new one and keeps the wallet', async () => {
    const world = new World();
    await run(world);
    // The first shell closed. OWS showed the key once and it was not saved.
    delete world.env.OWS_X402_KEY;
    world.reset();

    expect(await run(world)).toBe(ExitCode.OK);
    expect(world.walletsCreated).toBe(1);
    expect(world.keysMinted).toBe(1);
    const created = world.result('create-wallet');
    expect(created?.result).toBe('done');
    expect(created?.message).toContain('new policy key was minted');
    expect(world.env.OWS_X402_KEY).toContain(POLICY_TOKEN);
    expect(world.result('set-caps')?.result).toBe('skipped');
    expect(world.result('summary')?.next).toBe('ready');
  });

  it('a dry run in that shell says it would mint a key and mints nothing', async () => {
    const world = new World();
    await run(world);
    delete world.env.OWS_X402_KEY;
    world.reset();

    expect(await run(world, { dryRun: true })).toBe(ExitCode.OK);
    expect(world.keysMinted).toBe(0);
    expect(String(world.result('create-wallet')?.message)).toContain('would mint');
  });

  it('does not replace a wallet, whatever --path says the second time', async () => {
    const world = new World();
    await run(world);
    world.reset();
    await run(world, { path: 'generate' });
    expect(world.walletsCreated).toBe(1);
  });

  it('applies a cap given as a flag that differs from the stored one, and only that', async () => {
    const world = new World();
    await run(world);
    world.reset();
    await run(world, { maxPerCall: '0.10' });
    expect(getPath(world.raw, 'limits.maxPerCall')).toBe('0.10');
    expect(world.result('set-caps')?.wrote).toEqual(['limits.maxPerCall']);
  });
});

describe('a failure at any step', () => {
  it('stops with that step named and the underlying exit code, then resumes there', async () => {
    const world = new World();
    world.fundWith = 'never';
    expect(await run(world)).toBe(ExitCode.WAIT_TIMEOUT);
    const failed = world.events.at(-1);
    expect(failed).toMatchObject({
      step: 'fund',
      result: 'failed',
      errorCode: 48,
      errorName: 'wait_timeout',
    });
    expect(String(failed?.resume)).toContain('resumes at fund');
    expect(world.walletsCreated).toBe(1);

    // The funder arrives. Nothing before the fund step runs again.
    world.fundWith = 1_000_000n;
    world.reset();
    expect(await run(world)).toBe(ExitCode.OK);
    expect(world.walletsCreated).toBe(1);
    expect(world.result('create-wallet')?.result).toBe('skipped');
    expect(world.result('set-caps')?.result).toBe('skipped');
    expect(world.result('fund')?.result).toBe('done');
  });

  for (const at of ['createWallet', 'waitForFunds', 'dryRun', 'pay']) {
    it(`killed at ${at}: re-running finishes, with one wallet and one payment`, async () => {
      const world = new World();
      world.fault = { at };
      expect(await run(world)).not.toBe(ExitCode.OK);
      world.reset();
      expect(await run(world)).toBe(ExitCode.OK);
      expect(world.walletsCreated).toBe(1);
      expect(world.ledger.filter((r) => r.exitCode === 0)).toHaveLength(1);
      expect(world.result('summary')?.next).toBe('ready');
    });
  }

  it('a payment whose response was lost is retried and never paid for twice', async () => {
    const world = new World();
    world.fault = { at: 'payLostResponse' };
    expect(await run(world)).toBe(ExitCode.PAID_NO_RESPONSE);
    const failed = world.events.at(-1);
    expect(failed?.step).toBe('first-payment');
    expect(String(failed?.message)).toContain('cached authorization');

    const before = world.balance;
    world.reset();
    expect(await run(world)).toBe(ExitCode.OK);
    // The retry returned the key against the cached authorization: no second debit.
    expect(world.balance).toBe(before);
    expect(getPath(world.raw, 'auth.apiKey')).toBe(MINTED_KEY);
  });

  it('refuses to guess when a payment completed and its key was never stored', async () => {
    const world = new World();
    await run(world);
    // The key was returned once and the process died before it was kept.
    world.raw = setPath(world.raw, 'auth.apiKey', '');
    delete (world.raw.auth as Json).apiKey;
    world.reset();

    expect(await run(world)).toBe(ExitCode.GENERIC);
    const failed = world.events.at(-1);
    expect(failed).toMatchObject({ step: 'store-key', result: 'failed' });
    expect(String(failed?.message)).toContain('--repay');
    // And it did not quietly pay again.
    expect(world.ledger).toHaveLength(1);
  });

  it('pays again for a new key only when told to', async () => {
    const world = new World();
    await run(world);
    delete (world.raw.auth as Json).apiKey;
    world.reset();

    expect(await run(world, { repay: true })).toBe(ExitCode.OK);
    expect(world.ledger).toHaveLength(2);
    // A fresh authorization, not the cached one.
    expect(world.payments.at(-1)).toEqual({ dryRun: false, noCache: true });
    expect(getPath(world.raw, 'auth.apiKey')).toBe(MINTED_KEY);
  });

  it('reports a paid response with no api_key without claiming a key was stored', async () => {
    const world = new World();
    const deps = world.deps();
    const original = deps.callTest;
    deps.callTest = async (input) => {
      const result = await original(input);
      return input.dryRun ? result : { ...result, body: { nope: true } };
    };
    const code = await runSetupFlow(ACCEPTANCE, deps);
    expect(code).toBe(ExitCode.GENERIC);
    expect(world.events.at(-1)).toMatchObject({ step: 'first-payment', result: 'failed' });
    expect(getPath(world.raw, 'auth.apiKey')).toBeUndefined();
  });
});

describe('the operator decisions', () => {
  it('holds the key in OWS under --yes when no --path is given', async () => {
    const world = new World();
    await run(world, { path: undefined });
    expect(world.result('decisions')?.decisions).toMatchObject({ custody: 'ows' });
    expect(world.walletsCreated).toBe(1);
  });

  it('does not guess where the key is held without --yes and with no terminal', async () => {
    const world = new World();
    expect(await run(world, { path: undefined, yes: false })).toBe(ExitCode.GENERIC);
    expect(world.events.at(-1)).toMatchObject({ step: 'decisions', result: 'failed' });
    expect(String(world.events.at(-1)?.message)).toContain('--path');
    expect(world.walletsCreated).toBe(0);
    expect(world.writes).toBe(0);
  });

  it('refuses to guess the rest with no terminal and no --yes, and lists what is missing', async () => {
    const world = new World();
    const code = await run(world, {
      yes: false,
      maxPerCall: undefined,
      dailyCap: undefined,
      telemetry: undefined,
    });
    expect(code).toBe(ExitCode.GENERIC);
    const message = String(world.events.at(-1)?.message);
    expect(message).toContain('--max-per-call');
    expect(message).toContain('--daily-cap');
    // Telemetry is never a missing decision: it is on unless opted out.
    expect(message).not.toContain('--telemetry');
    expect(world.writes).toBe(0);
  });

  it('applies the defaults for the rest under --yes', async () => {
    const world = new World();
    await run(world, { maxPerCall: undefined, dailyCap: undefined, telemetry: undefined });
    expect(getPath(world.raw, 'limits.maxPerCall')).toBe('0.05');
    expect(getPath(world.raw, 'limits.dailyCap')).toBe('5.00');
    expect(getPath(world.raw, 'telemetry.sink.enabled')).toBe(true);
  });

  it('keeps telemetry off when the operator already opted out, and never asks', async () => {
    const world = new World();
    world.interactive = true;
    world.raw = { telemetry: { sink: { enabled: false } } };
    world.answers = { select: 'ows', ask: ['0.05', '5'], confirm: [false] };
    await run(world, {
      yes: false,
      maxPerCall: undefined,
      dailyCap: undefined,
      telemetry: undefined,
    });
    expect(world.result('decisions')?.decisions).toMatchObject({ telemetry: 'off' });
    expect(getPath(world.raw, 'telemetry.sink.enabled')).toBe(false);
  });

  it('prints the decisions back before acting on any of them', async () => {
    const world = new World();
    await run(world);
    const order = world.stepResults();
    expect(order.indexOf('decisions:done')).toBeLessThan(order.indexOf('create-wallet:done'));
    expect(world.result('decisions')?.decisions).toEqual({
      custody: 'ows',
      maxPerCall: '0.05',
      dailyCap: '5',
      telemetry: 'off',
      orgKey: null,
    });
  });

  it('asks in one block when there is a terminal, and uses the answers', async () => {
    const world = new World();
    world.interactive = true;
    world.answers = { select: 'ows', ask: ['0.07', '3'], confirm: [false, false] };
    const code = await run(world, {
      yes: false,
      path: undefined,
      maxPerCall: undefined,
      dailyCap: undefined,
      telemetry: undefined,
    });
    expect(code).toBe(ExitCode.OK);
    expect(getPath(world.raw, 'limits.maxPerCall')).toBe('0.07');
    expect(getPath(world.raw, 'limits.dailyCap')).toBe('3');
  });

  it('rejects a cap that is not a positive decimal', async () => {
    const world = new World();
    expect(await run(world, { maxPerCall: 'five' })).toBe(ExitCode.GENERIC);
    expect(await run(world, { dailyCap: '0' })).toBe(ExitCode.GENERIC);
  });

  it('takes telemetry on as a URL and an enabled flag', async () => {
    const world = new World();
    await run(world, { telemetry: 'on' });
    expect(getPath(world.raw, 'telemetry.sink.enabled')).toBe(true);
  });
});

describe('an existing organization key', () => {
  it('skips the test payment and stores a reference, not the key', async () => {
    const world = new World();
    world.env.MY_ORG_KEY = 'rh_live_org';
    expect(await run(world, { orgKey: 'env:MY_ORG_KEY' })).toBe(ExitCode.OK);
    expect(world.payments).toHaveLength(0);
    expect(world.result('first-payment')?.result).toBe('skipped');
    expect(getPath(world.raw, 'auth.apiKey')).toBe('env:MY_ORG_KEY');
    expect(world.result('store-key')?.verified).toBe('recognised');
  });

  it('on a second run stores nothing and asks Roundhouse nothing', async () => {
    const world = new World();
    world.env.MY_ORG_KEY = 'rh_live_org';
    await run(world, { orgKey: 'env:MY_ORG_KEY' });
    const writes = world.writes;
    world.keyRecognised = 'rejected';
    world.reset();

    expect(await run(world, { orgKey: 'env:MY_ORG_KEY' })).toBe(ExitCode.OK);
    expect(world.writes).toBe(writes);
    expect(world.result('store-key')?.result).toBe('skipped');
  });

  it('refuses the key itself on the command line', async () => {
    const world = new World();
    expect(await run(world, { orgKey: 'rh_live_secret' })).toBe(ExitCode.GENERIC);
    expect(JSON.stringify(world.events)).not.toContain('rh_live_secret');
  });

  it('fails the step when the variable is not exported, and resumes once it is', async () => {
    const world = new World();
    expect(await run(world, { orgKey: 'env:MY_ORG_KEY' })).toBe(ExitCode.GENERIC);
    expect(world.events.at(-1)).toMatchObject({ step: 'store-key', result: 'failed' });
    expect(String(world.events.at(-1)?.message)).toContain('MY_ORG_KEY');

    world.env.MY_ORG_KEY = 'rh_live_org';
    world.reset();
    expect(await run(world, { orgKey: 'env:MY_ORG_KEY' })).toBe(ExitCode.OK);
  });

  it('fails when Roundhouse does not recognise the key', async () => {
    const world = new World();
    world.env.MY_ORG_KEY = 'rh_live_revoked';
    world.keyRecognised = 'rejected';
    expect(await run(world, { orgKey: 'env:MY_ORG_KEY' })).toBe(ExitCode.GENERIC);
    expect(String(world.events.at(-1)?.message)).toContain('does not recognise');
  });

  it('proceeds when Roundhouse cannot be reached to confirm it', async () => {
    const world = new World();
    world.env.MY_ORG_KEY = 'rh_live_org';
    world.keyRecognised = 'unknown';
    expect(await run(world, { orgKey: 'env:MY_ORG_KEY' })).toBe(ExitCode.OK);
    expect(world.result('store-key')?.verified).toBe('unknown');
  });

  it('adopts a key already exported as ROUNDHOUSE_API_KEY instead of paying for one', async () => {
    const world = new World();
    world.env.ROUNDHOUSE_API_KEY = 'rh_live_existing';
    expect(await run(world)).toBe(ExitCode.OK);
    expect(world.payments).toHaveLength(0);
    expect(getPath(world.raw, 'auth.apiKey')).toBe('env:ROUNDHOUSE_API_KEY');
  });
});

describe('--dry-run', () => {
  it('makes no wallet, no config write and no payment, and exits 0', async () => {
    const world = new World();
    expect(await run(world, { dryRun: true })).toBe(ExitCode.OK);
    expect(world.walletsCreated).toBe(0);
    expect(world.writes).toBe(0);
    expect(world.payments).toHaveLength(0);
    expect(world.raw).toEqual({});
    expect(world.stepResults()).toContain('create-wallet:planned');
    expect(world.stepResults().at(-1)).toBe('summary:planned');
  });

  it('with a funded wallet, exercises the payment gates and still pays nothing', async () => {
    const world = new World();
    await run(world, { keyEnv: 'K' });
    delete (world.raw.auth as Json).apiKey;
    world.ledger = [];
    world.reset();
    world.payments = [];
    const writes = world.writes;

    expect(await run(world, { dryRun: true })).toBe(ExitCode.OK);
    expect(world.payments).toEqual([{ dryRun: true, noCache: false }]);
    expect(world.writes).toBe(writes);
  });
});

describe('the environment step', () => {
  it('stops on a Node that is too old, before touching anything', async () => {
    const world = new World();
    world.nodeVersion = '18.19.0';
    expect(await run(world)).toBe(ExitCode.GENERIC);
    expect(world.events.at(-1)).toMatchObject({ step: 'environment', result: 'failed' });
    expect(String(world.events.at(-1)?.message)).toContain('older than the 20.10.0');
    expect(world.writes).toBe(0);
    expect(world.walletsCreated).toBe(0);
  });

  it('notes an unwritable global npm directory and never suggests sudo', async () => {
    const world = new World();
    const deps = world.deps();
    deps.globalInstallWritable = () => false;
    await runSetupFlow(ACCEPTANCE, deps);
    const message = String(world.result('environment')?.message);
    expect(message).toContain('npx @roundhouseai/x402');
    expect(message).toContain('Do not use sudo');
    expect(message).not.toMatch(/sudo npm|sudo -/);
  });
});
