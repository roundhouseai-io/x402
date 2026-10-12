import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, mergeDeep, type X402Config } from '../src/core/config.js';
import { parseArgs } from '../src/core/args.js';
import {
  collectStatus,
  nextStep,
  nodeMeetsMinimum,
  STEPS,
  type StatusDeps,
  type StepFacts,
} from '../src/core/status.js';
import { formatStatus, statusRows } from '../src/commands/status.js';
import { ExitCode, X402Error } from '../src/core/errors.js';
import type { LedgerRecord } from '../src/core/ledger.js';
import type { SignerBackend } from '../src/core/signer.js';
import type { WalletBalances } from '../src/core/rpc.js';

const ADDRESS = '0x2D43136FfBbbe0ED5CBaaB2E8B2b8c968059114C';
const NOW = Date.parse('2026-10-02T12:00:00Z');

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-status-'));
  process.env.X402_HOME = home;
});
afterEach(() => {
  delete process.env.X402_HOME;
  rmSync(home, { recursive: true, force: true });
});

const configWith = (patch: unknown): X402Config => mergeDeep(DEFAULT_CONFIG, patch);

const READY_CONFIG = {
  wallet: { backend: 'ows-core', default: 'agent', path: 'ows' },
  limits: { maxPerCall: '0.05', dailyCap: '5' },
};

function signer(over: { typedData?: boolean; policies?: boolean; address?: string } = {}) {
  const backend: SignerBackend = {
    backend: 'ows-core',
    wallet: 'agent',
    capabilities: async () => ({
      typedData: over.typedData ?? true,
      policies: over.policies ?? false,
      balances: false,
      accounts: true,
      declared: true,
    }),
    getAccounts: async () => [],
    getAddress: async () => over.address ?? ADDRESS,
    signTypedData: async () => '0x',
  };
  return backend;
}

function balances(amount: string, atomic: string): WalletBalances {
  return {
    address: ADDRESS,
    chain: 'base',
    chainId: 8453,
    rpcUrl: 'x',
    native: { symbol: 'ETH', amount: '0', atomic: '0', decimals: 18 },
    tokens: [{ symbol: 'usdc', amount, atomic, decimals: 6 }],
    canPayX402: BigInt(atomic) > 0n,
  };
}

function record(over: {
  url?: string;
  paid?: boolean;
  ts?: string;
  amount?: string;
}): LedgerRecord {
  return {
    id: 'id',
    ts: over.ts ?? '2026-10-02T09:00:00Z',
    url: over.url ?? 'https://api.example.com/x',
    method: 'GET',
    wallet: 'agent',
    request: { bytes: 0 },
    payment: { paid: over.paid ?? true, amount: over.amount ?? '0.01', asset: 'usdc' },
    response: { status: 200, bytes: 0, latencyMs: 1 },
    exitCode: 0,
    agent: {},
  };
}

function deps(over: Partial<StatusDeps> & { config?: unknown } = {}): Partial<StatusDeps> {
  const { config, ...rest } = over;
  return {
    loadConfig: () => ({ config: configWith(config ?? READY_CONFIG) }),
    readRawConfig: () => ({}),
    resolveSigner: async () => signer(),
    readBalances: async () => balances('2', '2000000'),
    readRecords: () => [],
    env: {},
    nodeVersion: '22.1.0',
    now: NOW,
    ...rest,
  };
}

describe('node version', () => {
  it('compares numerically, so 20.9 is below 20.10', () => {
    expect(nodeMeetsMinimum('20.10.0')).toBe(true);
    expect(nodeMeetsMinimum('v22.1.0')).toBe(true);
    expect(nodeMeetsMinimum('20.9.5')).toBe(false);
    expect(nodeMeetsMinimum('18.19.0')).toBe(false);
  });
});

describe('the next step', () => {
  const done: StepFacts = {
    nodeOk: true,
    signerReady: true,
    capsSet: true,
    funded: true,
    everPaid: true,
    firstPaymentDone: true,
    apiKeySet: true,
  };

  it('is the first step that is not done, in the documented order', () => {
    expect(nextStep(done)).toBe('ready');
    expect(nextStep({ ...done, apiKeySet: false })).toBe('store-key');
    expect(nextStep({ ...done, apiKeySet: false, firstPaymentDone: false })).toBe('first-payment');
    expect(nextStep({ ...done, funded: false, everPaid: false, firstPaymentDone: false })).toBe(
      'fund',
    );
    expect(nextStep({ ...done, capsSet: false, funded: false })).toBe('set-caps');
    expect(nextStep({ ...done, signerReady: false, capsSet: false })).toBe('create-wallet');
    expect(nextStep({ ...done, nodeOk: false, signerReady: false })).toBe('install');
  });

  it('does not send a wallet that has already paid back to `fund` when the balance dips', () => {
    expect(nextStep({ ...done, funded: false, everPaid: true })).toBe('ready');
  });

  it('only names steps the document has headings for', () => {
    expect([...STEPS]).toEqual([
      'install',
      'create-wallet',
      'set-caps',
      'fund',
      'first-payment',
      'store-key',
      'ready',
    ]);
  });
});

describe('collectStatus', () => {
  it('reports every field of the table on a machine with nothing configured', async () => {
    const s = await collectStatus({
      deps: deps({ config: {}, resolveSigner: async () => signer() }),
    });
    expect(s.signer.path).toBe('none');
    expect(s.signer.address).toBeNull();
    expect(s.balance.usdc).toBeNull();
    expect(s.limits).toEqual({ maxPerCall: 'unset', dailyCap: 'unset' });
    expect(s.auth.apiKey).toBe('unset');
    // The sink is on by default; opting out is a config key or DO_NOT_TRACK.
    expect(s.telemetry.enabled).toBe(true);
    expect(s.spend).toEqual({ today: '0', calls: { today: 0, total: 0 } });
    expect(s.next).toBe('create-wallet');
  });

  it('walks a half-finished setup to the right step', async () => {
    const caps = { wallet: READY_CONFIG.wallet };
    expect((await collectStatus({ deps: deps({ config: caps }) })).next).toBe('set-caps');

    const poor = await collectStatus({
      deps: deps({ readBalances: async () => balances('0', '0') }),
    });
    expect(poor.next).toBe('fund');
    expect(poor.balance.usdc).toBe('0');

    const funded = await collectStatus({ deps: deps() });
    expect(funded.next).toBe('first-payment');
  });

  it('is ready once a key is configured, and never carries the key', async () => {
    const secret = 'rh_live_supersecretvalue';
    const s = await collectStatus({
      deps: deps({
        config: { ...READY_CONFIG, auth: { apiKey: secret } },
        readRecords: () => [record({ url: 'https://api.roundhouseai.io/v0/test/x402' })],
      }),
    });
    expect(s.next).toBe('ready');
    expect(s.auth).toEqual({ apiKey: 'set', source: 'config' });
    expect(JSON.stringify(s)).not.toContain(secret);
    expect(formatStatus(s)).not.toContain(secret);
  });

  it('names the variable when auth.apiKey points at one that is not exported', async () => {
    const s = await collectStatus({
      deps: deps({
        config: { ...READY_CONFIG, auth: {} },
        readRawConfig: () => ({ auth: { apiKey: 'env:ROUNDHOUSE_API_KEY' } }),
      }),
    });
    expect(s.auth.apiKey).toBe('unset');
    expect(s.warnings.join('\n')).toContain('ROUNDHOUSE_API_KEY');
  });

  it('asks for store-key when a key is in the environment but not in config', async () => {
    const s = await collectStatus({
      deps: deps({ env: { ROUNDHOUSE_API_KEY: 'rh_live_x' } }),
    });
    expect(s.next).toBe('store-key');
  });

  it('treats a settled test payment with no stored key as store-key, not as unpaid', async () => {
    const s = await collectStatus({
      deps: deps({
        readRecords: () => [record({ url: 'https://api.roundhouseai.io/v0/test/x402?x=1' })],
      }),
    });
    expect(s.next).toBe('store-key');
  });

  it('keeps first-payment as the next step after a paid call that returned no response', async () => {
    // Exit 50: the authorization is cached and a re-run is safe and productive.
    const s = await collectStatus({
      deps: deps({
        readRecords: () => [
          { ...record({ url: 'https://api.roundhouseai.io/v0/test/x402' }), exitCode: 50 },
        ],
      }),
    });
    expect(s.next).toBe('first-payment');
  });

  it('counts only paid calls made since UTC midnight', async () => {
    const s = await collectStatus({
      deps: deps({
        readRecords: () => [
          record({ amount: '0.25' }),
          record({ amount: '0.5' }),
          record({ amount: '9', ts: '2026-10-01T23:59:00Z' }),
          record({ amount: '4', paid: false }),
        ],
      }),
    });
    expect(s.spend).toEqual({ today: '0.75', calls: { today: 2, total: 3 } });
  });

  it('reports a signer outage as fields rather than throwing', async () => {
    const s = await collectStatus({
      deps: deps({
        resolveSigner: async () => {
          throw new X402Error(ExitCode.OWS_UNREACHABLE, 'ows is down');
        },
      }),
    });
    expect(s.signer.address).toBeNull();
    expect(s.signer.typedData).toBe(false);
    expect(s.signer.error).toBe('ows is down');
    expect(s.next).toBe('create-wallet');
  });

  it('reports a balance it could not read as null with the reason, and asks to fund', async () => {
    const s = await collectStatus({
      deps: deps({
        readBalances: async () => {
          throw new Error('RPC rate limited');
        },
      }),
    });
    expect(s.balance.usdc).toBeNull();
    expect(s.balance.error).toBe('RPC rate limited');
    expect(s.next).toBe('fund');
  });

  it('survives an unreadable config file and still answers', async () => {
    const s = await collectStatus({
      deps: deps({
        loadConfig: () => {
          throw new X402Error(ExitCode.GENERIC, 'cannot read config: Unexpected token');
        },
      }),
    });
    expect(s.config.ok).toBe(false);
    expect(s.config.error).toContain('Unexpected token');
    expect(s.warnings.join('\n')).toContain('config could not be read');
    expect(s.next).toBe('create-wallet');
  });

  it('judges funding against --min-balance', async () => {
    const half = deps({ readBalances: async () => balances('0.5', '500000') });
    expect((await collectStatus({ deps: half })).next).toBe('fund');
    expect((await collectStatus({ minBalance: '0.25', deps: half })).next).toBe('first-payment');
  });

  it('says policy is active only when the backend reports a key in force', async () => {
    const on = await collectStatus({
      deps: deps({ resolveSigner: async () => signer({ policies: true }) }),
    });
    expect(on.signer.policy).toBe('active');
    const off = await collectStatus({ deps: deps() });
    expect(off.signer.policy).toBe('none');
    const local = await collectStatus({
      deps: deps({
        config: { ...READY_CONFIG, wallet: { backend: 'local', default: 'dev', path: 'import' } },
      }),
    });
    expect(local.signer.policy).toBe('n/a');
    expect(local.signer.path).toBe('import');
  });

  it('does not guess between import and generate for a keystore it has no record of', async () => {
    const s = await collectStatus({
      deps: deps({ config: { ...READY_CONFIG, wallet: { backend: 'local', default: 'dev' } } }),
    });
    expect(s.signer.path).toBe('other');
  });

  it('warns when a policy-only wallet has no key exported', async () => {
    const s = await collectStatus({
      deps: deps({
        config: {
          ...READY_CONFIG,
          wallet: {
            ...READY_CONFIG.wallet,
            backends: { 'ows-core': { requireApiKey: true } },
          },
        },
      }),
    });
    expect(s.warnings.join('\n')).toContain('OWS_X402_KEY');
    expect(s.signer.policyKey).toBe('missing');
    // The address resolves and typed data is supported, but it cannot sign.
    expect(s.next).toBe('create-wallet');
  });

  it('flags an old Node', async () => {
    const s = await collectStatus({ deps: deps({ nodeVersion: '18.19.0' }) });
    expect(s.node.ok).toBe(false);
    expect(s.next).toBe('install');
  });
});

describe('the table', () => {
  it('has one row per documented field', async () => {
    const s = await collectStatus({ deps: deps() });
    expect(statusRows(s).map(([k]) => k)).toEqual(
      expect.arrayContaining([
        'cli.version',
        'node.version',
        'node.ok',
        'signer.path',
        'signer.address',
        'signer.typedData',
        'signer.policy',
        'balance.usdc',
        'balance.chain',
        'limits.maxPerCall',
        'limits.dailyCap',
        'auth.apiKey',
        'telemetry.enabled',
        'spend.today',
        'spend.calls.today',
        'next',
      ]),
    );
  });
});

describe('--json on status', () => {
  it('is a switch, not a value-taking flag', () => {
    const parsed = parseArgs(['status', '--json']);
    expect(parsed.command).toBe('status');
    expect(parsed.flags.json).toBe(true);
  });

  it('keeps taking a value on call', () => {
    const parsed = parseArgs(['call', 'https://x.test', '--json', '{"a":1}']);
    expect(parsed.flags.json).toBe('{"a":1}');
  });
});

describe('status on a config that does not load', () => {
  it('reports a plain value over the telemetry group instead of throwing', async () => {
    // `status` threw "Cannot read properties of undefined (reading 'enabled')"
    // after `config set telemetry on`.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ telemetry: 'on' }));
    const s = await collectStatus({
      deps: deps({ loadConfig: () => loadConfig() }),
    });
    expect(s.config.ok).toBe(false);
    expect(s.config.error).toMatch(/"telemetry" must be a group of settings/);
    expect(s.telemetry.enabled).toBe(false);
  });
});

describe('a local keystore wallet that cannot sign in this shell', () => {
  const LOCAL = {
    wallet: { backend: 'local', default: 'dev', path: 'generate' },
    limits: { maxPerCall: '0.05', dailyCap: '5' },
  };

  it('warns about a missing passphrase and a missing ethers before any payment', async () => {
    const s = await collectStatus({
      deps: deps({ config: LOCAL, env: {}, ethersAvailable: async () => false }),
    });
    expect(s.warnings.join('\n')).toMatch(/X402_KEYSTORE_PASS/);
    expect(s.warnings.join('\n')).toMatch(/npx -p @roundhouseai\/x402 -p ethers/);
  });

  it('says nothing when both are there', async () => {
    const s = await collectStatus({
      deps: deps({
        config: LOCAL,
        env: { X402_KEYSTORE_PASS: 'x' },
        ethersAvailable: async () => true,
      }),
    });
    expect(s.warnings).toEqual([]);
  });
});
