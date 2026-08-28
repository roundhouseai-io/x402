import { describe, it, expect } from 'vitest';
import {
  CONFIG_KEYS,
  defaultedConfigKeys,
  suggestConfigKeys,
  assertKnownConfigKey,
  unsetPath,
  type Json,
} from '../src/core/config.js';
import { ExitCode, X402Error } from '../src/core/errors.js';

describe('rejecting a config key this build does not have', () => {
  it('accepts the keys the default config declares', () => {
    for (const key of [
      'wallet.backend',
      'wallet.default',
      'limits.maxPerCall',
      'allowlist.payTo',
      'defaults.chain',
      'discover.indexUrl',
      'telemetry.payload',
      'serve.port',
    ]) {
      expect(() => assertKnownConfigKey(key)).not.toThrow();
    }
  });

  it('refuses an unknown key and names the one that was meant', () => {
    // The real failure this comes from: an agent set `signer.backend local`,
    // got `ok: true`, and every later command used the default backend while
    // the config file looked configured.
    try {
      assertKnownConfigKey('signer.backend');
      throw new Error('should have thrown');
    } catch (err) {
      // SAFETY: the line above proves this threw; the reads below fail the test
      // if it was not an X402Error, which is the assertion.
      expect((err as X402Error).code).toBe(ExitCode.GENERIC);
      expect((err as Error).message).toContain('unknown config key "signer.backend"');
      expect((err as Error).message).toContain('wallet.backend');
    }
  });

  it('suggests across a wrong prefix, matching on the last segment', () => {
    expect(suggestConfigKeys('signer.backend')).toContain('wallet.backend');
    expect(suggestConfigKeys('wallet.bakend')).toContain('wallet.backend');
    expect(suggestConfigKeys('limits.maxPerCal')).toContain('limits.maxPerCall');
  });

  it('leaves backend and pin subtrees open, because their keys are not ours', () => {
    // A third-party `x402-signer-acme` may need any key at all.
    expect(() => assertKnownConfigKey('wallet.backends.acme.region')).not.toThrow();
    expect(() => assertKnownConfigKey('wallet.backends.ows-core.vaultPath')).not.toThrow();
    expect(() => assertKnownConfigKey('pins.web-search')).not.toThrow();
  });

  it('lists every key the default config sets, so the two cannot drift', () => {
    // The list is written by hand because optional keys have no default. This
    // guards the direction that can rot silently: a new defaulted key that
    // nobody added to CONFIG_KEYS would be rejected by `config set`.
    const missing = defaultedConfigKeys().filter((k) => !CONFIG_KEYS.includes(k));
    expect(missing).toEqual([]);
  });

  it('stops at an open subtree rather than enumerating current backends', () => {
    expect(CONFIG_KEYS).toContain('wallet.backends');
    expect(CONFIG_KEYS).not.toContain('wallet.backends.ows.endpoint');
  });
});

describe('removing a config key', () => {
  const config = (): Json => ({
    wallet: { backend: 'local', backends: { acme: { region: 'eu-west-1' } } },
    limits: { maxPerCall: 0.05 },
  });

  it('removes the key and reports that it did', () => {
    const { config: out, removed } = unsetPath(config(), 'wallet.backend');
    expect(removed).toBe(true);
    expect(out).toEqual({
      wallet: { backends: { acme: { region: 'eu-west-1' } } },
      limits: { maxPerCall: 0.05 },
    });
  });

  it('prunes an object the removal emptied', () => {
    const { config: out } = unsetPath(config(), 'wallet.backends.acme.region');
    // Not `{ wallet: { backend, backends: { acme: {} } } }` — hollow branches
    // accumulate and make `config list` harder to read than it needs to be.
    expect(out).toEqual({ wallet: { backend: 'local' }, limits: { maxPerCall: 0.05 } });
  });

  it('is a no-op for a key that was never set', () => {
    const { config: out, removed } = unsetPath(config(), 'wallet.nothing.here');
    expect(removed).toBe(false);
    expect(out).toEqual(config());
  });

  it('does not validate, so a key written before the check can still be removed', () => {
    const stale: Json = { signer: { backend: 'local' }, wallet: { backend: 'local' } };
    const { config: out, removed } = unsetPath(stale, 'signer.backend');
    expect(removed).toBe(true);
    expect(out).toEqual({ wallet: { backend: 'local' } });
  });
});
