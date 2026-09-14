import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { paths, writePrivate } from './paths.js';
import { X402Error, ExitCode } from './errors.js';

export type PayloadLevel = 'none' | 'hash' | 'full';

export interface OwsBackendConfig {
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface OwsCoreBackendConfig {
  /** OWS vault directory; OWS's own default when unset. */
  vaultPath?: string;
  /**
   * Vault passphrase. Use an `env:` indirection, never the literal.
   *
   * This is *owner* access: it can sign anything the wallet can sign. Prefer
   * `apiKey`, which is the same vault behind a policy.
   */
  passphrase?: string;
  /**
   * An OWS API key token. Use an `env:` indirection, never the literal.
   *
   * Signing with this instead of the passphrase is what puts the OWS policy
   * engine in front of every signature — it is the difference between a spend
   * control that binds and one this CLI merely promises. Create one with
   * `rh-x402 wallet policy`.
   */
  apiKey?: string;
  /**
   * Refuse to sign at all unless `apiKey` resolves.
   *
   * `env:` indirections resolve to undefined when the variable is unset — an
   * unset token is a disabled feature, not a bogus credential. For a policy
   * credential that default is wrong: it would silently downgrade a
   * policy-gated wallet to owner access, and the operator would never know,
   * because payments keep working. This flag makes the opt-in durable, so a
   * shell missing the token gets an error instead of an ungated signature.
   *
   * Written by `rh-x402 wallet policy` and by the guided setup.
   */
  requireApiKey?: boolean;
}

export interface LocalBackendConfig {
  /** Encrypted keystore path; `~` is expanded. Defaults to `$X402_HOME/keystore.json`. */
  keystore?: string;
  passphrase?: string;
}

export interface ExecBackendConfig {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface X402Config {
  wallet: {
    /** Active signer backend. See docs/signers.md. */
    backend: string;
    /** Wallet name or id within the active backend. */
    default?: string;
    /**
     * Wallets to hide from this CLI. They are untouched in the backend.
     *
     * This exists so "remove this wallet from my tooling" never has to mean
     * "destroy this wallet". A hidden OWS wallet still holds its funds and is
     * still there for `ows wallet list`; it simply stops appearing here.
     */
    hidden?: string[];
    backends: {
      ows: OwsBackendConfig;
      'ows-core'?: OwsCoreBackendConfig;
      local: LocalBackendConfig;
      exec?: ExecBackendConfig;
      /** Third-party backends resolved as `x402-signer-<name>`. */
      [name: string]: unknown;
    };
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
    /** Roundhouse read API base. Queried as `<indexUrl>/endpoints?q=<term>`. */
    indexUrl: string;
    /**
     * Capability documents, which carry the market stats `indexUrl` does not.
     * Queried as `<unifiedUrl>/<slug>`; a value ending in `.json` is treated as
     * the retired single-document surface and queried as `?capability=<slug>`.
     */
    unifiedUrl: string;
  };
  /** Settlement confirmation source for `rh-x402 verify`. */
  facilitator: {
    url?: string;
    token?: string;
  };
  /** Capability -> fixed provider URL. Determinism over price. */
  pins: Record<string, string>;
  /**
   * chain -> JSON-RPC endpoint, overriding the built-in public one.
   *
   * Read-only, and used only by `wallet balance`. The payment path never calls
   * an RPC: an x402 payment is a signed authorization the facilitator submits.
   */
  rpc: Record<string, string>;
  serve: {
    host: string;
    port: number;
  };
}

export const DEFAULT_CONFIG: X402Config = {
  wallet: {
    backend: 'ows',
    backends: {
      ows: { endpoint: 'http://127.0.0.1:8402' },
      local: {},
    },
  },
  limits: {},
  allowlist: { payTo: [], domains: [] },
  telemetry: {
    payload: 'hash',
    redactKeys: [],
    sink: { enabled: false, batchSize: 50, batchIntervalMs: 10_000 },
  },
  defaults: { chain: 'base', timeout: 30 },
  discover: {
    indexUrl: 'https://api.roundhouseai.io/v0',
    unifiedUrl: 'https://api.roundhouseai.io/v0/unified',
  },
  facilitator: {},
  pins: {},
  rpc: {},
  serve: { host: '127.0.0.1', port: 8403 },
};

/**
 * Config values that are money amounts, and must be strings.
 *
 * `config set limits.maxPerCall 0.05` coerces its argument, so the cap landed
 * in `config.json` as the JSON *number* `0.05` while `limits.dailyCap "5.00"`
 * stayed a string. Reading the number back threw `value.trim is not a function`
 * from `parseUnits` and every `pay`/`call` without an explicit `--max` failed
 * with exit 1 — a configured spend cap that could not be used. Amounts are
 * normalised to strings on write and again on read, so a file written by an
 * older build behaves too.
 */
export const AMOUNT_KEYS: readonly string[] = ['limits.maxPerCall', 'limits.dailyCap'];

/** Coerce a value destined for `key` into the type that key must hold. */
export function normalizeConfigValue(key: string, value: unknown): unknown {
  if (AMOUNT_KEYS.includes(key) && typeof value === 'number') return String(value);
  return value;
}

/** Coerce every amount in a loaded config to a string, in place of the caller. */
export function normalizeAmounts<T>(config: T): T {
  const limits = (config as { limits?: Record<string, unknown> }).limits;
  if (!limits) return config;
  const fixed: Record<string, unknown> = { ...limits };
  for (const key of AMOUNT_KEYS) {
    const leaf = key.split('.')[1]!;
    if (typeof fixed[leaf] === 'number') fixed[leaf] = String(fixed[leaf]);
  }
  return { ...config, limits: fixed } as T;
}

export type Json = Record<string, unknown>;

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
  /** Which layer each leaf came from, so a default is distinguishable. */
  origins: Record<string, ValueOrigin>;
}

/** ~/.x402/config.json < ./.x402rc < flags. `env:` values resolved last. */
export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const sources: string[] = [];
  let merged: X402Config = DEFAULT_CONFIG;

  const layers: { user?: Json; project?: Json; flags?: Json } = {};

  const userFile = opts.file ? resolve(opts.file) : paths.config();
  if (existsSync(userFile)) {
    const user = readJsonFile(userFile);
    merged = mergeDeep(merged, user);
    layers.user = user;
    sources.push(userFile);
  }

  const rc = join(opts.cwd ?? process.cwd(), '.x402rc');
  if (existsSync(rc)) {
    const project = readJsonFile(rc);
    merged = mergeDeep(merged, project);
    layers.project = project;
    sources.push(rc);
  }

  if (opts.overrides && Object.keys(opts.overrides).length > 0) {
    merged = mergeDeep(merged, opts.overrides);
    layers.flags = opts.overrides as Json;
    sources.push('flags');
  }

  return {
    config: normalizeAmounts(resolveEnv(merged)),
    sources,
    origins: originsOf(layers),
  };
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

/**
 * Dotted paths whose children are open-ended, so anything below them is valid.
 *
 * `wallet.backends.<name>` takes whatever a backend needs — a third-party
 * `x402-signer-acme` may want `region`, and this file cannot know that.
 * `pins` is a capability -> URL map with arbitrary keys.
 */
const OPEN_SUBTREES = ['wallet.backends', 'pins', 'rpc'];

/**
 * Every settable dotted path.
 *
 * Written out rather than derived from `DEFAULT_CONFIG`, because the optional
 * keys — `wallet.default`, `limits.maxPerCall`, `facilitator.url` and the rest
 * — have no default and would be missing from a derived list. Rejecting a key
 * that is genuinely valid would be a worse bug than the one this prevents.
 * `configKeysAreComplete` in the tests guards the other direction: a new
 * defaulted key that nobody added here.
 */
export const CONFIG_KEYS: readonly string[] = [
  'wallet',
  'wallet.backend',
  'wallet.default',
  'wallet.hidden',
  'wallet.backends',
  'limits',
  'limits.maxPerCall',
  'limits.dailyCap',
  'allowlist',
  'allowlist.payTo',
  'allowlist.domains',
  'telemetry',
  'telemetry.payload',
  'telemetry.redactKeys',
  'telemetry.sink',
  'telemetry.sink.enabled',
  'telemetry.sink.url',
  'telemetry.sink.token',
  'telemetry.sink.batchSize',
  'telemetry.sink.batchIntervalMs',
  'defaults',
  'defaults.chain',
  'defaults.timeout',
  'discover',
  'discover.indexUrl',
  'discover.unifiedUrl',
  'facilitator',
  'facilitator.url',
  'facilitator.token',
  'pins',
  'rpc',
  'serve',
  'serve.host',
  'serve.port',
];

/** The dotted paths `DEFAULT_CONFIG` actually contains, for the drift guard. */
export function defaultedConfigKeys(
  node: unknown = DEFAULT_CONFIG,
  prefix = '',
  out: string[] = [],
): string[] {
  if (!isPlainObject(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    if (!OPEN_SUBTREES.includes(path)) defaultedConfigKeys(value, path, out);
  }
  return out;
}

/** Levenshtein distance, for suggesting what the caller probably meant. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitute = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, substitute);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** The known keys closest to `key`, best first, for a "did you mean". */
export function suggestConfigKeys(key: string, limit = 3): string[] {
  const leaf = key.split('.').pop() ?? key;
  return CONFIG_KEYS.slice()
    .map((candidate) => ({
      candidate,
      // Score on the whole path and on the last segment, and keep the better of
      // the two: `signer.backend` should find `wallet.backend` on its leaf even
      // though the prefixes share nothing.
      score: Math.min(
        editDistance(key, candidate),
        editDistance(leaf, candidate.split('.').pop() ?? candidate),
      ),
    }))
    .filter((m) => m.score <= 3)
    .sort((a, b) => a.score - b.score || a.candidate.length - b.candidate.length)
    .slice(0, limit)
    .map((m) => m.candidate);
}

/**
 * Reject a key the config does not have, rather than writing it and reporting
 * success.
 *
 * Writing an unknown key is worse than useless: `config set signer.backend
 * local` used to return `ok: true`, change nothing, and leave the caller
 * believing the backend was switched while every later command used the
 * default. Silent misconfiguration in a tool that spends money is not a
 * usability wrinkle.
 */
export function assertKnownConfigKey(key: string): void {
  if (CONFIG_KEYS.includes(key)) return;
  // Anything below an open subtree is the backend's business, not ours.
  if (OPEN_SUBTREES.some((root) => key.startsWith(`${root}.`))) return;

  const suggestions = suggestConfigKeys(key);
  throw new X402Error(
    ExitCode.GENERIC,
    `unknown config key "${key}"` +
      (suggestions.length > 0 ? `. Did you mean ${suggestions.join(', ')}?` : '') +
      '\nRun `rh-x402 config list` to see every key this build understands.',
  );
}

/**
 * Remove a dotted key, pruning any object it leaves empty.
 *
 * The counterpart to `set`: without it, a key written by mistake can only be
 * removed by hand-editing `config.json`, which is the thing this command
 * exists to avoid.
 */
export function unsetPath(obj: Json, dotted: string): { config: Json; removed: boolean } {
  const parts = dotted.split('.').filter(Boolean);
  if (parts.length === 0) return { config: obj, removed: false };

  let removed = false;
  const walk = (node: Json, depth: number): Json => {
    const key = parts[depth];
    if (key === undefined) return node;
    const copy: Json = { ...node };
    if (depth === parts.length - 1) {
      if (Object.hasOwn(copy, key)) {
        delete copy[key];
        removed = true;
      }
      return copy;
    }
    const child = copy[key];
    if (!isPlainObject(child)) return copy;
    const next = walk(child, depth + 1);
    // Prune an object the removal emptied, so `config list` does not grow
    // hollow branches over time.
    if (Object.keys(next).length === 0) delete copy[key];
    else copy[key] = next;
    return copy;
  };

  return { config: walk(obj, 0), removed };
}

/** Where an effective config value came from. */
export type ValueOrigin = 'default' | 'user' | 'project' | 'flag';

/**
 * Label each leaf of the effective config with the layer it came from.
 *
 * `config list` shows a merged object, so a defaulted value and one the user
 * chose look identical. That is how `wallet.backend: "ows"` reads as something
 * deliberate when nobody set it — and why an unset default can look like it is
 * "overriding" a key that was set somewhere else. Saying which layer won makes
 * that self-diagnosing.
 */
export function originsOf(layers: {
  user?: Json;
  project?: Json;
  flags?: Json;
}): Record<string, ValueOrigin> {
  const out: Record<string, ValueOrigin> = {};
  const mark = (node: unknown, origin: ValueOrigin, prefix = ''): void => {
    if (!isPlainObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainObject(value)) mark(value, origin, path);
      else out[path] = origin;
    }
  };
  // Later layers win, matching how the config itself is merged.
  for (const path of defaultedConfigKeys()) out[path] = 'default';
  mark(layers.user, 'user');
  mark(layers.project, 'project');
  mark(layers.flags, 'flag');
  return out;
}
