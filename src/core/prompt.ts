import { createInterface } from 'node:readline';
import { X402Error, ExitCode } from './errors.js';

/**
 * Terminal prompts, on Node built-ins only.
 *
 * Every prompt here is for the *guided* path. Nothing in the payment loop may
 * block on one: an agent runs this CLI with no terminal attached, so callers
 * must check `interactive()` first and take flags instead. `secret()` never
 * echoes and its value never reaches argv.
 */

/** True when both ends are a terminal, so a question can actually be answered. */
export const interactive = (): boolean =>
  process.stdin.isTTY === true && process.stdout.isTTY === true;

function requireTty(): void {
  if (!interactive()) {
    throw new X402Error(
      ExitCode.GENERIC,
      'no terminal attached: pass the answers as flags instead (see --help)',
    );
  }
}

/** Prompts are written to stderr so stdout stays a clean machine-readable stream. */
function write(text: string): void {
  process.stderr.write(text);
}

async function question(text: string): Promise<string> {
  requireTty();
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await new Promise<string>((resolve) => rl.question(text, resolve));
  } finally {
    rl.close();
  }
}

/** Free text, with a default applied when the answer is empty. */
export async function ask(text: string, fallback?: string): Promise<string> {
  const suffix = fallback === undefined ? ': ' : ` [${fallback}]: `;
  const answer = (await question(`${text}${suffix}`)).trim();
  if (answer) return answer;
  return fallback ?? '';
}

export async function confirm(text: string, fallback = false): Promise<boolean> {
  const answer = (await question(`${text} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === 'y' || answer === 'yes';
}

export interface Choice<T> {
  value: T;
  label: string;
  /** Shown indented under the label; keep it to the trade-off being made. */
  detail?: string;
}

/** A numbered picker. Returns the chosen value; re-asks until one is valid. */
export async function select<T>(text: string, choices: Choice<T>[], fallback = 0): Promise<T> {
  requireTty();
  write(`\n${text}\n\n`);
  choices.forEach((choice, i) => {
    write(`  ${i + 1}) ${choice.label}\n`);
    if (choice.detail) write(`     ${choice.detail}\n`);
  });
  write('\n');
  for (;;) {
    const answer = (await question(`choice [${fallback + 1}]: `)).trim();
    const index = answer === '' ? fallback : Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) {
      const chosen = choices[index];
      if (chosen) return chosen.value;
    }
    write(`enter a number from 1 to ${choices.length}\n`);
  }
}

const ENTER = ['\r', '\n'];
const CTRL_C = '\u0003';
const BACKSPACE = ['\u007f', '\b'];

/**
 * Read without echoing. Raw mode is restored on every exit path, Ctrl-C
 * included — leaving a terminal in raw mode makes the user's shell unusable.
 */
export async function secret(text: string): Promise<string> {
  requireTty();
  const stdin = process.stdin;
  write(text);
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const restore = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      write('\n');
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (ENTER.includes(char)) {
          restore();
          resolve(value);
          return;
        }
        if (char === CTRL_C) {
          restore();
          reject(new X402Error(ExitCode.GENERIC, 'cancelled'));
          return;
        }
        // Backspace and delete, so a typo is fixable without starting over.
        if (BACKSPACE.includes(char)) {
          if (value) {
            value = value.slice(0, -1);
            write('\b \b');
          }
          continue;
        }
        // Drop the rest of any escape sequence rather than storing arrow keys.
        if (char < ' ') continue;
        value += char;
        write('*');
      }
    };
    stdin.on('data', onData);
  });
}

/** Ask twice and require a match, so a mistyped passphrase is caught now. */
export async function secretTwice(text: string, confirmText: string): Promise<string> {
  const first = await secret(text);
  const second = await secret(confirmText);
  if (first !== second) {
    throw new X402Error(ExitCode.GENERIC, 'the two entries did not match; nothing was created');
  }
  return first;
}
