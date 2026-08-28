import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExitCode, X402Error } from '../src/core/errors.js';
import { installArgs, runSetup, KEY_PATHS, OWS_PACKAGE } from '../src/core/setup.js';
import { readRawConfig } from '../src/core/config.js';
import { defaultKeystorePath } from '../src/core/keystore.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-setup-'));
  process.env.X402_HOME = home;
});

afterEach(() => {
  delete process.env.X402_HOME;
  delete process.env.X402_KEYSTORE_PASS;
  delete process.env.OWS_VAULT_PASS;
  rmSync(home, { recursive: true, force: true });
});

describe('choosing where to install the bindings', () => {
  // The point of these: `loadOwsCore` imports from *this module's* location, so
  // an install into the shell's cwd can succeed and still not be loadable.
  const GLOBAL = '/usr/lib/node_modules';

  it('targets the project that owns this package, not the shell cwd', () => {
    expect(installArgs(false, '/srv/app/node_modules', GLOBAL)).toEqual([
      'install',
      '--prefix',
      '/srv/app',
      OWS_PACKAGE,
    ]);
  });

  it('uses -g when this package is itself installed globally', () => {
    expect(installArgs(false, GLOBAL, GLOBAL)).toEqual(['install', '-g', OWS_PACKAGE]);
  });

  it('falls back to the cwd when running from a source checkout', () => {
    expect(installArgs(false, undefined, GLOBAL)).toEqual(['install', OWS_PACKAGE]);
  });

  it('honours an explicit --install-global from anywhere', () => {
    expect(installArgs(true, '/srv/app/node_modules', GLOBAL)).toEqual([
      'install',
      '-g',
      OWS_PACKAGE,
    ]);
  });

  it('still works when the global root cannot be determined', () => {
    expect(installArgs(false, '/srv/app/node_modules', undefined)).toEqual([
      'install',
      '--prefix',
      '/srv/app',
      OWS_PACKAGE,
    ]);
  });
});

describe('guided setup, without a terminal', () => {
  it('offers the three key paths, best first', () => {
    expect(KEY_PATHS).toEqual(['ows', 'import', 'generate']);
  });

  it('refuses an unknown --path instead of guessing one', async () => {
    await expect(runSetup({ path: 'hardware' })).rejects.toThrow(/expected one of ows, import/);
  });

  it('says how to choose non-interactively rather than hanging on a prompt', async () => {
    // The failure mode this guards against is an agent blocking forever on a
    // question nothing can answer.
    await expect(runSetup({})).rejects.toThrow(/no terminal attached/);
  });

  it('names the package to install rather than installing it unasked', async () => {
    try {
      await runSetup({ path: 'ows', name: 'agent' });
      throw new Error('should have thrown');
    } catch (err) {
      // SAFETY: the assertion above proves this threw; the reads below fail the
      // test if it was not an X402Error, which is what is being asserted.
      expect((err as X402Error).code).toBe(ExitCode.OWS_UNREACHABLE);
      expect((err as Error).message).toContain(OWS_PACKAGE);
      expect((err as Error).message).toContain('--install');
    }
  });

  it('requires a key file to import, never a key on the command line', async () => {
    process.env.X402_KEYSTORE_PASS = 'correct horse battery';
    await expect(runSetup({ path: 'import' })).rejects.toThrow(/--key-file/);
  });

  it('will not write a keystore it cannot finish', async () => {
    // `ethers` is not installed here, and the address needs it. Loading it
    // before `addEntry` is what stops a key landing on disk under a name the
    // user believes failed.
    process.env.X402_KEYSTORE_PASS = 'correct horse battery';
    await expect(runSetup({ path: 'generate', name: 'dev' })).rejects.toThrow(/ethers/);
    expect(existsSync(defaultKeystorePath())).toBe(false);
    expect(readRawConfig()).toEqual({});
  });

  it('requires a passphrase before generating anything', async () => {
    await expect(runSetup({ path: 'generate', name: 'dev' })).rejects.toThrow(/X402_KEYSTORE_PASS/);
    expect(existsSync(defaultKeystorePath())).toBe(false);
  });
});
