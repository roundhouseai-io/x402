import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseDuration, formatDuration } from '../src/core/duration.js';
import { waitForBalance, type BalanceReading } from '../src/core/fundwait.js';
import { main } from '../src/cli.js';
import { ExitCode } from '../src/core/errors.js';

const ADDRESS = '0x2D43136FfBbbe0ED5CBaaB2E8B2b8c968059114C';

describe('durations', () => {
  it('reads a bare number as seconds and the usual suffixes', () => {
    expect(parseDuration('90')).toBe(90_000);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1500ms')).toBe(1_500);
    expect(parseDuration('0.5m')).toBe(30_000);
  });

  it('refuses what it cannot read rather than waiting 30 milliseconds', () => {
    expect(() => parseDuration('30 minutes')).toThrow(/duration/);
    expect(() => parseDuration('')).toThrow(/duration/);
    expect(() => parseDuration('-5')).toThrow(/duration/);
  });

  it('formats for a progress line', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(270_000)).toBe('4m 30s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });
});

/** A clock that only moves when the loop sleeps, so no test waits for real. */
function fakeTime() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const reading = (amount: string, atomic: bigint): BalanceReading => ({ amount, atomic });

describe('waiting for a balance', () => {
  it('returns as soon as the floor is met, without sleeping first', async () => {
    const time = fakeTime();
    const result = await waitForBalance({
      read: async () => reading('2', 2_000_000n),
      minAtomic: 1_000_000n,
      label: '1 USDC',
      timeoutMs: 60_000,
      ...time,
    });
    expect(result).toMatchObject({ met: true, amount: '2', polls: 1 });
    expect(time.now()).toBe(0);
  });

  it('keeps polling until the funds arrive', async () => {
    const time = fakeTime();
    const seen = [reading('0', 0n), reading('0', 0n), reading('1.5', 1_500_000n)];
    let i = 0;
    const result = await waitForBalance({
      read: async () => seen[Math.min(i++, seen.length - 1)]!,
      minAtomic: 1_000_000n,
      label: '1 USDC',
      timeoutMs: 600_000,
      intervalMs: 10_000,
      ...time,
    });
    expect(result.met).toBe(true);
    expect(result.polls).toBe(3);
    expect(result.elapsedMs).toBe(20_000);
  });

  it('times out with the last balance it saw', async () => {
    const time = fakeTime();
    const result = await waitForBalance({
      read: async () => reading('0.25', 250_000n),
      minAtomic: 1_000_000n,
      label: '1 USDC',
      timeoutMs: 30_000,
      intervalMs: 10_000,
      ...time,
    });
    expect(result).toMatchObject({ met: false, amount: '0.25' });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(30_000);
  });

  it('does not stop on a failed read, and reports it only if nothing ever succeeded', async () => {
    const time = fakeTime();
    let calls = 0;
    const flaky = await waitForBalance({
      read: async () => {
        calls++;
        if (calls < 3) throw new Error('RPC rate limited');
        return reading('3', 3_000_000n);
      },
      minAtomic: 1_000_000n,
      label: '1 USDC',
      timeoutMs: 600_000,
      ...fakeTime(),
    });
    expect(flaky.met).toBe(true);
    expect(flaky.lastError).toBe('RPC rate limited');

    const dead = await waitForBalance({
      read: async () => {
        throw new Error('RPC unreachable');
      },
      minAtomic: 1_000_000n,
      label: '1 USDC',
      timeoutMs: 20_000,
      ...time,
    });
    expect(dead).toMatchObject({ met: false, amount: null, lastError: 'RPC unreachable' });
  });

  it('prints at most one progress line a minute', async () => {
    const time = fakeTime();
    const lines: string[] = [];
    await waitForBalance({
      read: async () => reading('0', 0n),
      minAtomic: 1_000_000n,
      label: '1 USDC',
      timeoutMs: 300_000,
      intervalMs: 10_000,
      onProgress: (line) => lines.push(line),
      ...time,
    });
    // Five minutes at one line a minute, plus the opening line.
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]).toContain('waiting for 1 USDC');
  });

  it('never sleeps past the deadline', async () => {
    const time = fakeTime();
    await waitForBalance({
      read: async () => reading('0', 0n),
      minAtomic: 1n,
      label: 'x',
      timeoutMs: 25_000,
      intervalMs: 10_000,
      ...time,
    });
    expect(time.now()).toBe(25_000);
  });
});

/** An RPC that answers every eth_call with `usdc` atomic units. */
function stubChain(usdcAtomic: bigint) {
  const word = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { method: string };
    const result = req.method === 'eth_getBalance' ? word(0n) : word(usdcAtomic);
    return {
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    };
  });
}

function captureStdout(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return written;
}

describe('wallet balance --wait', () => {
  const wasTty = process.stdout.isTTY;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.stdout.isTTY = wasTty;
  });

  const args = (...extra: string[]) => [
    'wallet',
    'balance',
    '--address',
    ADDRESS,
    '--chain',
    'base',
    ...extra,
  ];

  it('exits 0 when the balance is already there', async () => {
    process.stdout.isTTY = false;
    stubChain(2_000_000n);
    const out = captureStdout();
    expect(await main(args('--wait', '--min', '1', '--timeout', '5s'))).toBe(ExitCode.OK);
    const body = JSON.parse(out.join('')) as { ok: boolean; met: boolean; amount: string };
    expect(body).toMatchObject({ ok: true, met: true, amount: '2', minimum: '1' });
  });

  it('exits 48 when time runs out, and says what it did see', async () => {
    process.stdout.isTTY = false;
    stubChain(250_000n);
    const out = captureStdout();
    expect(await main(args('--wait', '--min', '1', '--timeout', '0s'))).toBe(ExitCode.WAIT_TIMEOUT);
    const body = JSON.parse(out.join('')) as {
      errorCode: number;
      errorName: string;
      error: string;
    };
    expect(body.errorCode).toBe(48);
    expect(body.errorName).toBe('wait_timeout');
    expect(body.error).toContain('0.25');
  });

  it('checks once with --min alone, and exits 46 when short', async () => {
    process.stdout.isTTY = false;
    stubChain(250_000n);
    captureStdout();
    expect(await main(args('--min', '1'))).toBe(ExitCode.INSUFFICIENT_BALANCE);
  });

  it('refuses to watch two chains at once', async () => {
    process.stdout.isTTY = false;
    stubChain(0n);
    captureStdout();
    expect(await main(args('--chain', 'base,ethereum', '--wait', '--min', '1'))).toBe(
      ExitCode.GENERIC,
    );
  });

  it('takes a duration for --timeout here and seconds for a request elsewhere', async () => {
    process.stdout.isTTY = false;
    stubChain(2_000_000n);
    captureStdout();
    expect(await main(args('--wait', '--min', '1', '--timeout', '30m'))).toBe(ExitCode.OK);
  });
});
