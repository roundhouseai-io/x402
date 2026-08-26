import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { paths, writePrivate } from '../core/paths.js';
import { X402Error, ExitCode } from '../core/errors.js';

export interface CallerToken {
  name: string;
  /** sha256 of the plaintext token. The plaintext is shown once, never stored. */
  hash: string;
  budgetDaily?: string;
  maxPerCall?: string;
  /** Empty or absent means every capability. */
  capabilities?: string[];
  admin?: boolean;
  createdAt: string;
  revokedAt?: string;
}

interface TokenFile {
  version: 1;
  tokens: CallerToken[];
}

const PREFIX = 'x402_';

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function loadTokens(file = paths.tokens()): TokenFile {
  if (!existsSync(file)) return { version: 1, tokens: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as TokenFile;
    return { version: 1, tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [] };
  } catch (err) {
    throw new X402Error(ExitCode.GENERIC, `cannot read ${file}: ${(err as Error).message}`);
  }
}

export function saveTokens(store: TokenFile, file = paths.tokens()): void {
  writePrivate(file, `${JSON.stringify(store, null, 2)}\n`);
}

export interface CreateTokenInput {
  name: string;
  budgetDaily?: string | undefined;
  maxPerCall?: string | undefined;
  capabilities?: string[] | undefined;
  admin?: boolean;
}

export function createToken(
  input: CreateTokenInput,
  file = paths.tokens(),
): { token: CallerToken; plaintext: string } {
  const store = loadTokens(file);
  if (store.tokens.some((t) => t.name === input.name && !t.revokedAt)) {
    throw new X402Error(ExitCode.GENERIC, `a live token named "${input.name}" already exists`);
  }
  const plaintext = `${PREFIX}${randomBytes(24).toString('base64url')}`;
  const token: CallerToken = {
    name: input.name,
    hash: hashToken(plaintext),
    ...(input.budgetDaily ? { budgetDaily: input.budgetDaily } : {}),
    ...(input.maxPerCall ? { maxPerCall: input.maxPerCall } : {}),
    ...(input.capabilities && input.capabilities.length > 0
      ? { capabilities: input.capabilities }
      : {}),
    ...(input.admin ? { admin: true } : {}),
    createdAt: new Date().toISOString(),
  };
  store.tokens.push(token);
  saveTokens(store, file);
  return { token, plaintext };
}

export function revokeToken(name: string, file = paths.tokens()): boolean {
  const store = loadTokens(file);
  const token = store.tokens.find((t) => t.name === name && !t.revokedAt);
  if (!token) return false;
  token.revokedAt = new Date().toISOString();
  saveTokens(store, file);
  return true;
}

/** Constant-time lookup of a bearer token. */
export function verifyToken(plaintext: string, file = paths.tokens()): CallerToken | undefined {
  const digest = Buffer.from(hashToken(plaintext), 'hex');
  for (const token of loadTokens(file).tokens) {
    if (token.revokedAt) continue;
    const candidate = Buffer.from(token.hash, 'hex');
    if (candidate.length === digest.length && timingSafeEqual(candidate, digest)) return token;
  }
  return undefined;
}

/** A token with no capability list may call anything. */
export function tokenAllowsCapability(token: CallerToken, capability: string | undefined): boolean {
  if (!token.capabilities || token.capabilities.length === 0) return true;
  if (!capability) return false;
  return token.capabilities.includes(capability);
}
