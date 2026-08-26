import { readdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { paths, ensureDir, writePrivate } from './paths.js';
import { sha256 } from './ids.js';
import type { TypedData } from './eip3009.js';

/**
 * Cached signed authorization.
 *
 * Note the key deliberately omits `validBefore`: a key including it could never
 * be hit on a retry, since a retry computes a new expiry. Instead the key is
 * the request identity and the entry expires at its own `validBefore`.
 * See docs/idempotency.md.
 */
export interface AuthCacheEntry {
  key: string;
  url: string;
  method: string;
  wallet: string;
  backend: string;
  payTo: string;
  amountAtomic: string;
  asset: string;
  chain: string;
  scheme: string;
  network: string;
  nonce: string;
  validBefore: number;
  signature: string;
  typedData: TypedData;
  header: string;
  createdAt: string;
}

export interface AuthKeyInput {
  url: string;
  method: string;
  body: string;
  payTo: string;
  amountAtomic: bigint;
  asset: string;
  chain: string;
  wallet: string;
  backend: string;
}

export function authKey(input: AuthKeyInput): string {
  return sha256(
    [
      input.method.toUpperCase(),
      input.url,
      sha256(input.body),
      input.payTo.toLowerCase(),
      input.amountAtomic.toString(),
      input.asset.toLowerCase(),
      input.chain,
      input.backend,
      input.wallet,
    ].join('|'),
  );
}

const file = (key: string) => join(paths.authcache(), `${key}.json`);

export function readAuth(key: string, now = Date.now()): AuthCacheEntry | undefined {
  const path = file(key);
  if (!existsSync(path)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as AuthCacheEntry;
    if (entry.validBefore * 1000 <= now) {
      unlinkSync(path);
      return undefined;
    }
    return entry;
  } catch {
    return undefined;
  }
}

export function writeAuth(entry: AuthCacheEntry): void {
  ensureDir(paths.authcache());
  writePrivate(file(entry.key), `${JSON.stringify(entry, null, 2)}\n`);
}

export function dropAuth(key: string): void {
  const path = file(key);
  if (existsSync(path)) unlinkSync(path);
}

/** Delete expired entries. Called opportunistically; never fails a call. */
export function pruneAuthCache(now = Date.now()): number {
  const dir = paths.authcache();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(readFileSync(join(dir, name), 'utf8')) as AuthCacheEntry;
      if (entry.validBefore * 1000 <= now) {
        unlinkSync(join(dir, name));
        removed++;
      }
    } catch {
      unlinkSync(join(dir, name));
      removed++;
    }
  }
  return removed;
}
