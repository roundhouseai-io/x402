import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { skillCommand } from '../src/commands/skill.js';
import { ExitCode } from '../src/core/errors.js';
import type { ParsedArgs } from '../src/core/args.js';

/**
 * `SKILL.md` is the agent-facing contract, and `rh-x402 skill` is how an agent
 * reads it without knowing where npm put the package.
 */
const args = (flags: ParsedArgs['flags'] = {}): ParsedArgs => ({
  command: 'skill',
  positionals: [],
  flags,
  dataFlags: [],
});

/**
 * Pin the terminal check, since the branch under test is exactly that check
 * and vitest inherits a terminal when a developer runs it in one. `isTTY` is a
 * plain property on the stream, not a getter, so it is set and put back.
 */
const wasTty = process.stdout.isTTY;

afterEach(() => {
  vi.restoreAllMocks();
  process.stdout.isTTY = wasTty;
});

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

  it('prints the file as an envelope when stdout is not a terminal', () => {
    // Calls the command rather than spawning `dist/cli.js`: the suite runs
    // before the build in CI, and a test that needs a build artefact fails on
    // a clean checkout for a reason that has nothing to do with the code.
    process.stdout.isTTY = false;
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    expect(skillCommand(args())).toBe(ExitCode.OK);
    const parsed = JSON.parse(written.join('')) as { ok: boolean; skill: string; bytes: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.skill).toContain('name: x402');
    expect(parsed.bytes).toBeGreaterThan(1000);
  });

  it('prints raw markdown when asked for it', () => {
    process.stdout.isTTY = false;
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    expect(skillCommand(args({ raw: true }))).toBe(ExitCode.OK);
    const out = written.join('');
    expect(out.startsWith('{')).toBe(false);
    expect(out).toContain('name: x402');
    expect(out.endsWith('\n')).toBe(true);
  });
});
