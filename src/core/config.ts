import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { paths, writePrivate } from './paths.js';
import { X402Error, ExitCode } from './errors.js';

export type PayloadLevel = 'none' | 'hash' | 'full';

export interface X402Config {
  wallet: {
    default?: string;
    owsEndpoint: string;
    apiKey?: string;
  };
  limits: {
    maxPerCall?: string;
    dailyCap?: string;
  };
  allowlist: {
    payTo: string[];
    domains: string[];
  };
  telemetry: {
    payload: PayloadLevel;
    redactKeys: string[];
    sink: {
      enabled: boolean;
      url?: string;
      token?: string;
      batchSize: number;
      batchIntervalMs: number;
    };
  };
  defaults: {
    chain: string;
    timeout: number;
  };
  discover: {
    indexUrl: string;
  };
  /** Settlement confirmation source for `x402 verify`. */
  facilitator: {
    url?: string;
    token?: string;
  };
  /** Capability -> fixed provider URL. Determinism over price. */
  pins: Record<string, string>;
  serve: {
    host: string;
    port: number;
  };
}

export const DEFAULT_CONFIG: X402Config = {
  wallet: { owsEndpoint: 'http://127.0.0.1:8402' },
  limits: {},
  allowlist: { payTo: [], domains: [] },
  telemetry: {
    payload: 'hash',
    redactKeys: [],
    sink: { enabled: false, batchSize: 50, batchIntervalMs: 10_000 },
  },
  defaults: { chain: 'base', timeout: 30 },
  discover: { indexUrl: 'https://ioi.md/api/v1' },
  facilitator: {},
  pins: {},
  serve: { host: '127.0.0.1', port: 8403 },
};

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge where later sources win. Arrays replace, they do not concatenate. */
export function mergeDeep<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return override === undefined ? base : (override as T);
  const out: Json = isPlainObject(base) ? { ...(base as unknown as Json) } : {};
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) ? mergeDeep(out[k], v) : v;
  }
  return out as unknown as T;
}

/**
 * Resolve `env:NAME` indirections against the environment at read time.
 * A missing variable resolves to undefined rather than the literal string,
 * so an unset token is a disabled feature, not a bogus credential.
 */
export function resolveEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const name = value.slice(4);
    return env[name] as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnv(v, env)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveEnv(v, env);
    return out as unknown as T;
  }
  return value;
}

function readJsonFile(file: string): Json {
  try {
    const raw = readFileSync(file, 'utf8');
    if (raw.trim() === '') return {};
    return JSON.parse(raw) as Json;
  } catch (err) {
    throw new X402Error(ExitCode.GENERIC, `cannot read config ${file}: ${(err as Error).message}`);
  }
}

export interface LoadOptions {
  /** Directory to look for a project-level .x402rc in. Defaults to cwd. */
  cwd?: string;
  /** Explicit config file, bypasses ~/.x402/config.json discovery. */
  file?: string;
  /** Flag-derived overrides, highest precedence. */
  overrides?: Json;
}

export interface LoadedConfig {
  config: X402Config;
  sources: string[];
}

/** ~/.x402/config.json < ./.x402rc < flags. `env:` values resolved last. */
export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const sources: string[] = [];
  let merged: X402Config = DEFAULT_CONFIG;

  const userFile = opts.file ? resolve(opts.file) : paths.config();
  if (existsSync(userFile)) {
    merged = mergeDeep(merged, readJsonFile(userFile));
    sources.push(userFile);
  }

  const rc = join(opts.cwd ?? process.cwd(), '.x402rc');
  if (existsSync(rc)) {
    merged = mergeDeep(merged, readJsonFile(rc));
    sources.push(rc);
  }

  if (opts.overrides && Object.keys(opts.overrides).length > 0) {
    merged = mergeDeep(merged, opts.overrides);
    sources.push('flags');
  }

  return { config: resolveEnv(merged), sources };
}

/** The raw (unresolved) user config file, for `config get|set|list`. */
export function readRawConfig(file = paths.config()): Json {
  return existsSync(file) ? readJsonFile(file) : {};
}

export function writeRawConfig(value: Json, file = paths.config()): void {
  writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (!isPlainObject(acc)) return undefined;
    return acc[key];
  }, obj);
}

export function setPath(obj: Json, dotted: string, value: unknown): Json {
  const keys = dotted.split('.');
  let cursor: Json = obj;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (!isPlainObject(next)) cursor[key] = {};
    cursor = cursor[key] as Json;
  }
  cursor[keys[keys.length - 1]!] = value;
  return obj;
}
