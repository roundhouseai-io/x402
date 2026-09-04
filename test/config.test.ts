import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  mergeDeep,
  resolveEnv,
  DEFAULT_CONFIG,
  readRawConfig,
  writeRawConfig,
  setPath,
  getPath,
} from '../src/core/config.js';
import { authKey, readAuth, writeAuth, pruneAuthCache } from '../src/core/authcache.js';
import { mapOwsError } from '../src/core/ows.js';
import { domainAllowed, runGates, SessionBudget } from '../src/core/gates.js';
import { parsePaymentRequired } from '../src/core/x402.js';
import { ExitCode, X402Error } from '../src/core/errors.js';
import { paths } from '../src/core/paths.js';
import type { TypedData } from '../src/core/eip3009.js';

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-cfg-'));
  cwd = mkdtempSync(join(tmpdir(), 'x402-proj-'));
  process.env.X402_HOME = home;
});

afterEach(() => {
  delete process.env.X402_HOME;
  delete process.env.TEST_OWS_KEY;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('config precedence', () => {
  it('layers config.json, .x402rc and flags', () => {
    writeFileSync(
      paths.config(),
      JSON.stringify({ wallet: { default: 'user-wallet' }, limits: { maxPerCall: '0.05' } }),
    );
    writeFileSync(join(cwd, '.x402rc'), JSON.stringify({ limits: { maxPerCall: '0.01' } }));

    const { config, sources } = loadConfig({
      cwd,
      overrides: { defaults: { chain: 'base-sepolia' } },
    });
    expect(config.wallet.default).toBe('user-wallet');
    expect(config.limits.maxPerCall).toBe('0.01');
    expect(config.defaults.chain).toBe('base-sepolia');
    expect(config.defaults.timeout).toBe(30);
    expect(sources).toHaveLength(3);
  });

  it('resolves env: indirections at read time', () => {
    process.env.TEST_OWS_KEY = 'secret-key';
    writeFileSync(
      paths.config(),
      JSON.stringify({ wallet: { backends: { ows: { apiKey: 'env:TEST_OWS_KEY' } } } }),
    );
    expect(loadConfig({ cwd }).config.wallet.backends.ows.apiKey).toBe('secret-key');
  });

  it('treats a missing env var as absent, not as a literal', () => {
    expect(resolveEnv({ token: 'env:NOT_SET_ANYWHERE' })).toEqual({ token: undefined });
  });

  it('replaces arrays rather than concatenating them', () => {
    const merged = mergeDeep(DEFAULT_CONFIG, { allowlist: { domains: ['a.example'] } });
    expect(merged.allowlist.domains).toEqual(['a.example']);
  });

  it('writes config.json 0600 and round-trips dotted keys', () => {
    writeRawConfig(
      setPath(readRawConfig(), 'telemetry.sink.url', 'https://api.roundhouseai.io/v0/telemetry'),
    );
    expect(statSync(paths.config()).mode & 0o777).toBe(0o600);
    expect(getPath(readRawConfig(), 'telemetry.sink.url')).toBe(
      'https://api.roundhouseai.io/v0/telemetry',
    );
  });
});

describe('authorization cache', () => {
  const key = () =>
    authKey({
      url: 'https://api.example.com/v1/lei?query=Roundhouse',
      method: 'GET',
      body: '',
      payTo: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd',
      amountAtomic: 2000n,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chain: 'eip155:8453',
      wallet: 'my-agent',
      backend: 'ows',
    });

  it('is stable for the same request identity and case-insensitive on addresses', () => {
    expect(key()).toBe(key());
    const upper = authKey({
      url: 'https://api.example.com/v1/lei?query=Roundhouse',
      method: 'get',
      body: '',
      payTo: '0x1831F336585A6C67B6A954D28F3E07F44C4EEBBD',
      amountAtomic: 2000n,
      asset: '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913',
      chain: 'eip155:8453',
      wallet: 'my-agent',
      backend: 'ows',
    });
    expect(upper).toBe(key());
  });

  it('changes when the amount changes', () => {
    const other = authKey({
      url: 'https://api.example.com/v1/lei?query=Roundhouse',
      method: 'GET',
      body: '',
      payTo: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd',
      amountAtomic: 3000n,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chain: 'eip155:8453',
      wallet: 'my-agent',
      backend: 'ows',
    });
    expect(other).not.toBe(key());
  });

  it('expires entries at validBefore and prunes them', () => {
    const entry = {
      key: key(),
      url: 'https://api.example.com/v1/lei',
      method: 'GET',
      wallet: 'my-agent',
      backend: 'ows',
      payTo: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd',
      amountAtomic: '2000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chain: 'eip155:8453',
      scheme: 'exact',
      network: 'base',
      nonce: '0x00',
      validBefore: Math.floor(Date.now() / 1000) + 60,
      signature: '0xabc',
      typedData: {} as TypedData,
      header: 'base64',
      createdAt: new Date().toISOString(),
    };
    writeAuth(entry);
    expect(statSync(join(paths.authcache(), `${entry.key}.json`)).mode & 0o777).toBe(0o600);
    expect(readAuth(entry.key)?.signature).toBe('0xabc');
    // A clock past validBefore drops the entry.
    expect(readAuth(entry.key, (entry.validBefore + 1) * 1000)).toBeUndefined();

    writeAuth({ ...entry, validBefore: 1 });
    expect(pruneAuthCache()).toBe(1);
  });
});

describe('OWS error mapping', () => {
  it('maps policy denial to 42', () => {
    expect(mapOwsError(403, { error: 'policy denied: over daily limit' }, 'http://ows').code).toBe(
      ExitCode.POLICY_DENIED,
    );
  });

  it('maps auth failure to 47', () => {
    expect(mapOwsError(401, { error: 'bad api key' }, 'http://ows').code).toBe(
      ExitCode.OWS_UNREACHABLE,
    );
  });

  it('maps insufficient funds to 46', () => {
    expect(mapOwsError(400, { error: 'insufficient balance' }, 'http://ows').code).toBe(
      ExitCode.INSUFFICIENT_BALANCE,
    );
  });

  it('explains a missing typed-data method', () => {
    const err = mapOwsError(404, { error: 'not found' }, 'http://ows');
    expect(err.code).toBe(ExitCode.OWS_UNREACHABLE);
    expect(err.message).toContain('typed-data signing');
  });
});

describe('gates', () => {
  const option = parsePaymentRequired({
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '2000',
        payTo: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
    ],
  }).options[0]!;

  it('matches wildcard domains but not bare suffixes', () => {
    expect(domainAllowed('api.example.com', ['*.example.com'])).toBe(true);
    expect(domainAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(domainAllowed('api.example.com', [])).toBe(true);
    expect(domainAllowed('evil.com', ['api.example.com'])).toBe(false);
  });

  it('applies the documented gate order', () => {
    const call = () =>
      runGates({
        option,
        url: 'https://blocked.example/v1',
        allowDomains: ['api.allowed.example'],
        allowPayTo: ['0x0000000000000000000000000000000000000001'],
        maxPerCall: '0.0001',
      });
    // The domain gate fires before payTo and --max.
    expect(() => call()).toThrow(/domain not in allowlist/);
  });

  it('reports over-max as 44 and budget as 45', () => {
    try {
      runGates({ option, url: 'https://api.example.com', maxPerCall: '0.001' });
    } catch (err) {
      expect((err as X402Error).code).toBe(ExitCode.OVER_MAX);
    }
    try {
      runGates({ option, url: 'https://api.example.com', remainingBudgetAtomic: 100n });
    } catch (err) {
      expect((err as X402Error).code).toBe(ExitCode.BUDGET_EXHAUSTED);
    }
  });

  it('tracks a session budget across calls', () => {
    const budget = new SessionBudget(5000n);
    budget.record(2000n);
    expect(budget.remaining()).toBe(3000n);
    expect(new SessionBudget().remaining()).toBeUndefined();
  });
});
