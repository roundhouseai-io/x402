import { fstatSync } from 'node:fs';

/**
 * True when stdin is something that will actually deliver data and then EOF:
 * a pipe, a socket, or a redirected file.
 *
 * Terminals and character devices (`/dev/null`, a detached tty in a hosted
 * agent runtime) are excluded — reading those can block forever, which for an
 * agent looks like a hung payment.
 */
export function stdinIsReadable(
  stream: NodeJS.ReadStream & { fd?: number } = process.stdin,
): boolean {
  if (stream.isTTY) return false;
  try {
    const stat = fstatSync(stream.fd ?? 0);
    return stat.isFIFO() || stat.isFile() || stat.isSocket();
  } catch {
    return false;
  }
}

/**
 * How long to wait for stdin's first byte before deciding there is none.
 *
 * A pipe that nobody ever writes to is indistinguishable, at the descriptor
 * level, from one whose data has not arrived yet — `fstat` says FIFO either
 * way. That matters because the ordinary way to run this CLI from an agent is
 * `spawn(..., { stdio: 'pipe' })`, which opens stdin and never writes to it:
 * the read then blocks forever and the payment looks hung.
 *
 * So the wait is bounded, but only up to the *first* byte. Once anything
 * arrives the read runs to EOF with no deadline, so a slow producer is never
 * truncated mid-body. An explicit `-` (or `--json -`) waits indefinitely, on
 * the grounds that the caller said the data is coming.
 */
const DEFAULT_FIRST_BYTE_WAIT_MS = 500;

export interface ReadStdinOptions {
  /** Read even if the descriptor looks unreadable — for an explicit `-` argument. */
  force?: boolean;
  stream?: NodeJS.ReadStream;
  /** Override the first-byte deadline; 0 disables it. */
  firstByteWaitMs?: number;
}

function firstByteWait(opts: ReadStdinOptions): number {
  if (opts.firstByteWaitMs !== undefined) return opts.firstByteWaitMs;
  const fromEnv = Number(process.env.X402_STDIN_WAIT_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_FIRST_BYTE_WAIT_MS;
}

/**
 * Wait for the first chunk, or give up.
 *
 * Returns undefined for both "the deadline passed" and "the stream ended
 * empty", which are the same answer to the only question being asked: is there
 * piped input? The stream is left paused either way, so the caller can go on to
 * read the rest of it.
 */
function readFirstChunk(stream: NodeJS.ReadStream, ms: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onQuiet);
      stream.off('error', onQuiet);
      stream.pause();
    };
    const finish = (value: Buffer | undefined): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => finish(Buffer.from(chunk));
    const onQuiet = (): void => finish(undefined);
    const timer = setTimeout(onQuiet, ms);
    // Never let the deadline itself be the reason the process stays alive.
    timer.unref();
    stream.on('data', onData);
    stream.once('end', onQuiet);
    stream.once('error', onQuiet);
    stream.resume();
  });
}

/** Read piped stdin, or undefined when there is nothing to read. */
export async function readStdin(opts: ReadStdinOptions = {}): Promise<string | undefined> {
  const stream = opts.stream ?? process.stdin;
  if (!opts.force && !stdinIsReadable(stream)) return undefined;
  const chunks: Buffer[] = [];
  const deadline = opts.force ? 0 : firstByteWait(opts);
  if (deadline > 0) {
    const first = await readFirstChunk(stream, deadline);
    // Nothing within the deadline: an open pipe nobody is writing to. Leave it
    // alone rather than blocking, and let the command run without a body.
    if (first === undefined) return undefined;
    chunks.push(first);
  }
  // No encoding is set on the stream, so chunks are Buffers; a string chunk
  // (setEncoding called elsewhere) is re-encoded as UTF-8 rather than dropped.
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : text;
}
