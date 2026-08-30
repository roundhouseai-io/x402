import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { PassThrough } from 'node:stream';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStdin, stdinIsReadable } from '../src/core/stdin.js';

const dir = mkdtempSync(join(tmpdir(), 'x402-stdin-'));
const open: number[] = [];
let made = 0;

afterEach(() => {
  for (const fd of open.splice(0)) closeSync(fd);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A stream we control, wearing a descriptor that really is readable.
 *
 * `readStdin` stats the descriptor before reading, and under the test runner
 * fd 0 could be anything. Pointing `fd` at a real file makes that check
 * deterministic while leaving the data entirely under the test's control.
 */
function pipedStdin(): NodeJS.ReadStream & PassThrough {
  const file = join(dir, `fd-${(made += 1)}`);
  writeFileSync(file, '');
  const fd = openSync(file, 'r');
  open.push(fd);
  const stream = new PassThrough() as PassThrough & { fd?: number; isTTY?: boolean };
  stream.fd = fd;
  stream.isTTY = false;
  return stream as NodeJS.ReadStream & PassThrough;
}

describe('reading piped stdin', () => {
  it('gives up on a pipe nobody ever writes to', async () => {
    // The failure this closes: `spawn(cli, args, { stdio: 'pipe' })` — the
    // ordinary way an agent runs a subprocess — opens stdin and never writes
    // to it. The read blocked forever, and a hung read looks like a hung
    // payment. Nothing distinguishes that pipe from a slow one at the
    // descriptor level, so the wait is bounded instead.
    const stream = pipedStdin();
    expect(await readStdin({ stream, firstByteWaitMs: 20 })).toBeUndefined();
  });

  it('reads to EOF once data starts, however slow the rest is', async () => {
    // The deadline covers the first byte only. A producer that has started is
    // never truncated, which is what makes the bound safe to apply by default.
    const stream = pipedStdin();
    const read = readStdin({ stream, firstByteWaitMs: 20 });
    stream.write('{"a":');
    setTimeout(() => {
      stream.write('1}');
      stream.end();
    }, 80);
    expect(await read).toBe('{"a":1}');
  });

  it('waits as long as it takes when the caller said the data is coming', async () => {
    // `-` and `--json -` are explicit: the caller has promised input, so a
    // deadline would only truncate it.
    const stream = pipedStdin();
    const read = readStdin({ stream, force: true, firstByteWaitMs: 5 });
    setTimeout(() => {
      stream.write('later');
      stream.end();
    }, 60);
    expect(await read).toBe('later');
  });

  it('treats a pipe that closes without data as no input', async () => {
    const stream = pipedStdin();
    const read = readStdin({ stream, firstByteWaitMs: 500 });
    stream.end();
    expect(await read).toBeUndefined();
  });

  it('takes the deadline from the environment when one is set', async () => {
    process.env.X402_STDIN_WAIT_MS = '10';
    try {
      const stream = pipedStdin();
      const started = Date.now();
      expect(await readStdin({ stream })).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(400);
    } finally {
      delete process.env.X402_STDIN_WAIT_MS;
    }
  });

  it('never reads a terminal', () => {
    const tty = new PassThrough() as PassThrough & { isTTY?: boolean };
    tty.isTTY = true;
    expect(stdinIsReadable(tty as unknown as NodeJS.ReadStream)).toBe(false);
  });
});
