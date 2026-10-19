import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { paths, writePrivate } from '../core/paths.js';
import { X402Error, ExitCode, messageOf } from '../core/errors.js';
import { isJsonObject, isString, parseJson } from '../core/json.js';

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

const isOptional = <V>(value: V, check: (v: V) => boolean): boolean =>
  value === undefined || check(value);

/**
 * A stored token entry. A hand-edited file can hold anything, and `hash` is
 * what authenticates a caller, so an entry that is not this shape is dropped
 * rather than trusted.
 */
export function isCallerToken<T>(value: T): value is T & CallerToken {
  if (!isJsonObject(value)) return false;
  const { capabilities } = value;
  return (
    isString(value.name) &&
    isString(value.hash) &&
    isString(value.createdAt) &&
    isOptional(value.budgetDaily, isString) &&
    isOptional(value.maxPerCall, isString) &&
    isOptional(value.revokedAt, isString) &&
    (value.admin === undefined || value.admin === true || value.admin === false) &&
    (capabilities === undefined || (Array.isArray(capabilities) && capabilities.every(isString)))
  );
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function loadTokens(file = paths.tokens()): TokenFile {
  if (!existsSync(file)) return { version: 1, tokens: [] };
  try {
    const parsed = parseJson(readFileSync(file, 'utf8'));
    const tokens = isJsonObject(parsed) && Array.isArray(parsed.tokens) ? parsed.tokens : [];
    return { version: 1, tokens: tokens.filter(isCallerToken) };
  } catch (err) {
    throw new X402Error(ExitCode.GENERIC, `cannot read ${file}: ${messageOf(err)}`);
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

export interface CreatedToken {
  token: CallerToken;
  /** Shown to the operator once; only its hash is stored. */
  plaintext: string;
}

export function createToken(input: CreateTokenInput, file = paths.tokens()): CreatedToken {
  const store = loadTokens(file);
  if (store.tokens.some((t) => t.name === input.name && !t.revokedAt)) {
    throw new X402Error(ExitCode.GENERIC, `a live token named "${input.name}" already exists`);
  }
  const plaintext = `${PREFIX}${randomBytes(24).toString('base64url')}`;
  const token: CallerToken = {
    name: input.name,
    hash: hashToken(plaintext),
    createdAt: new Date().toISOString(),
  };
  if (input.budgetDaily) token.budgetDaily = input.budgetDaily;
  if (input.maxPerCall) token.maxPerCall = input.maxPerCall;
  if (input.capabilities && input.capabilities.length > 0) token.capabilities = input.capabilities;
  if (input.admin) token.admin = true;
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
