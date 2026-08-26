import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { join } from 'node:path';
import { writePrivate, x402Home } from './paths.js';
import { X402Error, ExitCode } from './errors.js';

/**
 * Encrypted keystore for the `local` signer backend: scrypt to stretch the
 * passphrase, AES-256-GCM to seal the key. Development and CI only — a `local`
 * wallet has no policy layer, so only the CLI-side caps apply to it.
 */
export interface KeystoreEntry {
  name: string;
  address: string;
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number; dkLen: number };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string };
  ciphertext: string;
  createdAt: string;
}

export interface KeystoreFile {
  version: 1;
  entries: KeystoreEntry[];
}

const KDF = { name: 'scrypt' as const, N: 16384, r: 8, p: 1, dkLen: 32 };
/** 128 * N * r plus headroom; the default 32 MiB is too tight for N=16384. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function expandPath(path: string): string {
  const expanded = path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Where the keystore lives when config does not say. This follows X402_HOME
 * like every other piece of state, so a test or a CI run never writes into a
 * developer's real `~/.x402`.
 */
export function defaultKeystorePath(): string {
  return join(x402Home(), 'keystore.json');
}

/** Resolve a configured keystore path, falling back to the default. */
export function keystorePath(configured?: string): string {
  return configured && configured.trim() !== '' ? expandPath(configured) : defaultKeystorePath();
}

function derive(passphrase: string, salt: Buffer, params = KDF): Buffer {
  return scryptSync(passphrase, salt, params.dkLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

export function readKeystore(file?: string): KeystoreFile {
  const path = keystorePath(file);
  if (!existsSync(path)) return { version: 1, entries: [] };
  const stat = statSync(path);
  if (stat.mode & 0o044) {
    throw new X402Error(
      ExitCode.GENERIC,
      `refusing to read a group- or world-readable keystore: ${path} (chmod 600 it)`,
    );
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
    return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (err) {
    throw new X402Error(
      ExitCode.GENERIC,
      `cannot read keystore ${path}: ${(err as Error).message}`,
    );
  }
}

export function writeKeystore(store: KeystoreFile, file?: string): void {
  writePrivate(keystorePath(file), `${JSON.stringify(store, null, 2)}\n`);
}

export interface AddEntryInput {
  name: string;
  /** 0x-prefixed 32-byte hex. Never comes from argv. */
  privateKey: string;
  address: string;
  passphrase: string;
  /** Defaults to `$X402_HOME/keystore.json`. */
  file?: string;
  replace?: boolean;
}

export function addEntry(input: AddEntryInput): KeystoreEntry {
  if (input.passphrase.length < 8) {
    throw new X402Error(ExitCode.GENERIC, 'keystore passphrase must be at least 8 characters');
  }
  const store = readKeystore(input.file);
  if (store.entries.some((e) => e.name === input.name) && !input.replace) {
    throw new X402Error(
      ExitCode.GENERIC,
      `keystore already holds "${input.name}"; pass --replace to overwrite it`,
    );
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = derive(input.passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(input.privateKey, 'utf8'), cipher.final()]);

  const entry: KeystoreEntry = {
    name: input.name,
    address: input.address,
    kdf: { ...KDF, salt: salt.toString('hex') },
    cipher: {
      name: 'aes-256-gcm',
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
    },
    ciphertext: ciphertext.toString('hex'),
    createdAt: new Date().toISOString(),
  };
  writeKeystore(
    { version: 1, entries: [...store.entries.filter((e) => e.name !== input.name), entry] },
    input.file,
  );
  return entry;
}

export function decryptEntry(entry: KeystoreEntry, passphrase: string): string {
  const key = derive(passphrase, Buffer.from(entry.kdf.salt, 'hex'), entry.kdf);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.cipher.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(entry.cipher.tag, 'hex'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `wrong passphrase for keystore entry "${entry.name}"`,
    );
  }
}

export function findEntry(file: string | undefined, name: string): KeystoreEntry {
  const store = readKeystore(file);
  const entry = store.entries.find((e) => e.name === name);
  if (!entry) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `keystore ${keystorePath(file)} has no wallet "${name}" ` +
        `(have: ${store.entries.map((e) => e.name).join(', ') || 'none'})`,
    );
  }
  return entry;
}

/** Read a 32-byte hex key from a file. Never from argv, never from an env var. */
export function readKeyFile(path: string): string {
  const stat = statSync(path);
  if (stat.mode & 0o004) {
    throw new X402Error(ExitCode.GENERIC, `refusing to read a world-readable key file: ${path}`);
  }
  const raw = readFileSync(path, 'utf8').trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    throw new X402Error(ExitCode.GENERIC, `${path} does not contain a 32-byte hex private key`);
  }
  return raw.startsWith('0x') ? raw : `0x${raw}`;
}
