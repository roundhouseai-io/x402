import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRawConfig, writeRawConfig, type Json } from '../src/core/config.js';
import { writeConfig, unsetConfig } from '../src/core/setup.js';
import { noDaemonHint } from '../src/core/ows.js';

/**
 * A wallet holds money. Removing it from *this tool* must never mean removing
 * it from OWS, so the destructive bindings are not merely unused — they are
 * unreachable, and this file is what keeps them that way.
 */
const FORBIDDEN = ['deleteWallet', 'exportWallet', 'renameWallet'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('destroying an OWS wallet is not something this CLI can do', () => {
  /** Comments may name these to explain the ban; code may not use them. */
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('never references a destructive OWS binding in code anywhere in src/', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const name of FORBIDDEN) {
        if (new RegExp(`\\b${name}\\b`).test(code)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the stripper does not simply blind the check', () => {
    // A guard that cannot fail is not a guard: prove it still sees a real call.
    const stripped = stripComments(`
      // deleteWallet is forbidden
      /* exportWallet too */
      const x = ows.deleteWallet('treasury');
    `);
    expect(stripped).toContain('deleteWallet');
    expect(stripped).not.toContain('forbidden');
    expect(stripped).not.toContain('exportWallet');
  });

  it('does not declare them on the module interface, so they cannot be called', () => {
    const owscore = readFileSync('src/core/signers/owscore.ts', 'utf8');
    const iface = owscore.slice(
      owscore.indexOf('export interface OwsCoreModule {'),
      owscore.indexOf('/** Load the bindings on demand'),
    );
    for (const name of FORBIDDEN) {
      expect(iface).not.toContain(`${name}(`);
    }
  });
});

describe('hiding a wallet instead of deleting it', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'x402-hide-'));
    process.env.X402_HOME = home;
  });

  afterEach(() => {
    delete process.env.X402_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('records the name in config and touches nothing else', () => {
    writeConfig({ 'wallet.backend': 'ows-core', 'wallet.default': 'treasury' });
    writeConfig({ 'wallet.hidden': ['treasury'] });
    const raw = readRawConfig() as { wallet: { hidden: string[]; backend: string } };
    expect(raw.wallet.hidden).toEqual(['treasury']);
    // The backend config is untouched: hiding is a local view change.
    expect(raw.wallet.backend).toBe('ows-core');
  });

  it('clears a default that pointed at the hidden wallet', () => {
    writeConfig({ 'wallet.default': 'treasury' });
    expect(unsetConfig('wallet.default')).toBe(true);
    const raw = readRawConfig() as { wallet?: { default?: string } };
    expect(raw.wallet?.default).toBeUndefined();
  });

  it('is reversible, because nothing was destroyed', () => {
    writeConfig({ 'wallet.hidden': ['treasury', 'ops'] });
    writeConfig({ 'wallet.hidden': ['ops'] });
    const raw = readRawConfig() as { wallet: { hidden: string[] } };
    expect(raw.wallet.hidden).toEqual(['ops']);
  });

  it('keeps hiding to config.json, never to the vault', () => {
    // Nothing under the OWS vault path is written by hiding: the only file
    // this touches is the CLI's own config.
    const before: Json = { wallet: { backend: 'ows-core' } };
    writeRawConfig(before);
    writeConfig({ 'wallet.hidden': ['treasury'] });
    expect(readdirSync(home).sort()).toEqual(['config.json']);
  });
});

describe('an OWS endpoint that nothing is listening on', () => {
  it('names the daemon-free backend instead of implying a service to start', () => {
    // The failure this comes from: an agent read "OWS unreachable at
    // 127.0.0.1:8402" as a service that had not started, and spent the session
    // grepping `ows --help` and `ps aux` for a daemon that does not exist.
    const hint = noDaemonHint('http://127.0.0.1:8402');
    expect(hint).toContain('ships no daemon');
    expect(hint).toContain('ows-core');
  });

  it('says nothing extra about a remote endpoint, where a service may well exist', () => {
    expect(noDaemonHint('https://ows.internal.example.com')).toBe('');
  });

  it('says nothing about an endpoint it cannot parse', () => {
    expect(noDaemonHint('not a url')).toBe('');
  });
});
