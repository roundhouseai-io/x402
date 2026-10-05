import { describe, it, expect } from 'vitest';
import { parseArgs, parseHeaders } from '../src/core/args.js';

describe('parseArgs', () => {
  it('treats a bare URL as `call`', () => {
    const parsed = parseArgs(['https://api.example.com/v1/lei']);
    expect(parsed.command).toBe('call');
    expect(parsed.positionals).toEqual(['https://api.example.com/v1/lei']);
  });

  it('treats a capability URI as `call`', () => {
    expect(parseArgs(['x402:lei']).command).toBe('call');
  });

  it('keeps an explicit command', () => {
    const parsed = parseArgs(['probe', 'https://api.example.com']);
    expect(parsed.command).toBe('probe');
    expect(parsed.positionals).toEqual(['https://api.example.com']);
  });

  it('collects dot-path data flags in both spellings', () => {
    const parsed = parseArgs([
      'https://x.test',
      '--data.company.name',
      'Roundhouse AI Ltd.',
      '--data.checks[0]=sanctions',
    ]);
    expect(parsed.dataFlags).toEqual([
      { path: 'company.name', value: 'Roundhouse AI Ltd.' },
      { path: 'checks[0]', value: 'sanctions' },
    ]);
  });

  it('does not let a boolean flag swallow the next argument', () => {
    const parsed = parseArgs(['--dry-run', 'https://x.test']);
    expect(parsed.command).toBe('call');
    expect(parsed.positionals).toEqual(['https://x.test']);
    expect(parsed.flags['dry-run']).toBe(true);
  });

  it('supports aliases, repeatable headers and inline values', () => {
    const parsed = parseArgs([
      'call',
      'https://x.test',
      '-X',
      'PUT',
      '-H',
      'X-Api-Version: 2',
      '-H',
      'X-Trace: abc',
      '--timeout=5',
      '-w',
      'my-agent',
    ]);
    expect(parsed.flags.method).toBe('PUT');
    expect(parsed.flags.header).toEqual(['X-Api-Version: 2', 'X-Trace: abc']);
    expect(parsed.flags.timeout).toBe(5);
    expect(parsed.flags.wallet).toBe('my-agent');
  });

  it('understands --no- prefixes for booleans', () => {
    expect(parseArgs(['--no-cache', 'https://x.test']).flags['cache']).toBeUndefined();
    expect(parseArgs(['--no-raw', 'https://x.test']).flags['raw']).toBe(false);
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['--max'])).toThrow(/needs a value/);
  });

  it('stops flag parsing at --', () => {
    const parsed = parseArgs(['call', 'https://x.test', '--', '--not-a-flag']);
    expect(parsed.positionals).toEqual(['https://x.test', '--not-a-flag']);
  });
});

describe('parseHeaders', () => {
  it('splits on the first colon', () => {
    expect(parseHeaders(['X-Api-Version: 2', 'X-Weird: a: b'])).toEqual({
      'X-Api-Version': '2',
      'X-Weird': 'a: b',
    });
  });

  it('rejects malformed headers', () => {
    expect(() => parseHeaders(['nope'])).toThrow(/malformed/);
  });
});
