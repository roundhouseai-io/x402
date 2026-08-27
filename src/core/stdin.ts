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
    const stat = fstatSync(typeof stream.fd === 'number' ? stream.fd : 0);
    return stat.isFIFO() || stat.isFile() || stat.isSocket();
  } catch {
    return false;
  }
}

export interface ReadStdinOptions {
  /** Read even if the descriptor looks unreadable — for an explicit `-` argument. */
  force?: boolean;
  stream?: NodeJS.ReadStream;
}

/** Read piped stdin, or undefined when there is nothing to read. */
export async function readStdin(opts: ReadStdinOptions = {}): Promise<string | undefined> {
  const stream = opts.stream ?? process.stdin;
  if (!opts.force && !stdinIsReadable(stream)) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : text;
}
