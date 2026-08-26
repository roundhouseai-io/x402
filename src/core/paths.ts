import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync, chmodSync, existsSync } from 'node:fs';

/** Root of all CLI state. Override with X402_HOME (useful in tests and CI). */
export function x402Home(): string {
  return process.env.X402_HOME && process.env.X402_HOME.length > 0
    ? process.env.X402_HOME
    : join(homedir(), '.x402');
}

export const paths = {
  home: x402Home,
  config: () => join(x402Home(), 'config.json'),
  ledger: () => join(x402Home(), 'ledger.jsonl'),
  authcache: () => join(x402Home(), 'authcache'),
  outbox: () => join(x402Home(), 'outbox'),
  tokens: () => join(x402Home(), 'tokens.json'),
};

/** Create a directory 0700. State dirs are never world-readable. */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort on exotic filesystems */
  }
  return dir;
}

/** Write a file 0600, creating parents. */
export function writePrivate(file: string, data: string): void {
  ensureDir(join(file, '..'));
  writeFileSync(file, data, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

/** Append to a file, guaranteeing it exists 0600 first. */
export function appendPrivate(file: string, line: string): void {
  ensureDir(join(file, '..'));
  if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
  appendFileSync(file, line);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}
