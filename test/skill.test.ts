import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * `SKILL.md` is the agent-facing contract, and `rh-x402 skill` is how an agent
 * reads it without knowing where npm put the package.
 */
describe('the skill command', () => {
  it('is listed in --help alongside every other command', () => {
    const help = readFileSync('src/cli.ts', 'utf8');
    for (const command of [
      'call',
      'probe',
      'pay',
      'verify',
      'wallet create',
      'wallet balance',
      'history',
      'discover',
      'serve',
      'signer',
      'config',
      'skill',
    ]) {
      expect(help).toContain(`rh-x402 ${command}`);
    }
  });

  it('shows worked examples, not just a command list', () => {
    const help = readFileSync('src/cli.ts', 'utf8');
    expect(help).toContain('examples');
    // The examples must cover the whole loop, or they teach half a workflow.
    expect(help).toContain('rh-x402 wallet create');
    expect(help).toContain('rh-x402 probe');
    expect(help).toContain('rh-x402 pay @402.json');
    expect(help).toContain('exit codes');
  });

  it('ships SKILL.md in the published package', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };
    // Without this the command resolves a file that is not there once installed.
    expect(pkg.files).toContain('SKILL.md');
  });

  it('prints the file, and as an envelope when stdout is not a terminal', () => {
    const out = execFileSync('node', ['dist/cli.js', 'skill'], {
      encoding: 'utf8',
      env: { ...process.env, X402_HOME: '/tmp/x402-skill-test' },
    });
    const parsed = JSON.parse(out) as { ok: boolean; skill: string; bytes: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.skill).toContain('name: x402');
    expect(parsed.bytes).toBeGreaterThan(1000);
  });
});
