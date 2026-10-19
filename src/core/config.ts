import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { paths, writePrivate } from './paths.js';
import { X402Error, ExitCode } from './errors.js';
import {
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from './json.js';

export type PayloadLevel = 'none' | 'hash' | 'full';

export type OwsBackendConfig = {
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
};

export type OwsCoreBackendConfig = {
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
};

export type LocalBackendConfig = {
  /** Encrypted keystore path; `~` is expanded. Defaults to `$X402_HOME/keystore.json`. */
  keystore?: string;
  passphrase?: string;
};

export type ExecBackendConfig = {
  command: string;
  args?: string[];
  timeoutMs?: number;
};

export type X402Config = {
  wallet: {
    /** Active signer backend. See docs/signers.md. */
    backend: string;
    /** Wallet name or id within the active backend. */
    default?: string;
    /**
     * How the key is held: `ows`, `import` or `generate`. Written by
     * `wallet create` so `status` can report a custody decision rather than
     * infer it; the backend alone cannot tell an imported keystore key from a
     * generated one.
     */
    path?: 'ows' | 'import' | 'generate';
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
      /** Third-party backends resolved as `x402-signer-<name>`: their own JSON settings. */
      [name: string]: JsonValue | undefined;
    };
  };
  limits: {
    maxPerCall?: string;
    dailyCap?: string;
  };
  /**
   * The Roundhouse API key, sent as `Authorization: Bearer` to Roundhouse hosts.
   * An `env:NAME` reference is preferred; a literal is accepted because an
   * unattended setup has no operator to export it. Never printed by `config get`,
   * `config list` or `status`.
   */
  auth: {
    apiKey?: string;
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
};

/** The Roundhouse ingest endpoint. See docs/telemetry.md for what it stores. */
export const TELEMETRY_URL = 'https://api.roundhouseai.io/v0/telemetry';

/**
 * Whether the environment opts this process out of the remote sink.
 *
 * The sink is on by default, so turning it off has to be possible without
 * writing config: a CI job or a one-off shell should not need a file to say no.
 * `DO_NOT_TRACK=1` is the cross-tool convention; `X402_TELEMETRY=off` is ours.
 */
export function telemetryOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  const own = env.X402_TELEMETRY?.trim().toLowerCase();
  return (
    (dnt !== undefined && dnt !== '' && dnt !== '0' && dnt !== 'false') ||
    own === 'off' ||
    own === '0' ||
    own === 'false' ||
    own === 'no'
  );
}

/**
 * Environment variables that override an endpoint, for a fork, a self-hosted
 * index or a test deployment. The defaults are the public Roundhouse
 * endpoints; nothing here is a secret, and a token still belongs in an `env:`
 * reference in config. Precedence: defaults < env < config file < .x402rc <
 * flags, so a value someone wrote down deliberately still wins.
 */
export const ENDPOINT_ENV: readonly { env: string; key: string }[] = [
  { env: 'X402_INDEX_URL', key: 'discover.indexUrl' },
  { env: 'X402_UNIFIED_URL', key: 'discover.unifiedUrl' },
  { env: 'X402_TELEMETRY_URL', key: 'telemetry.sink.url' },
  { env: 'X402_FACILITATOR_URL', key: 'facilitator.url' },
];

/** The endpoint overrides present in `env`, as a config layer. */
export function endpointEnvLayer(env: NodeJS.ProcessEnv = process.env): Json {
  const layer: Json = {};
  for (const { env: name, key } of ENDPOINT_ENV) {
    const value = env[name]?.trim();
    if (value) setPath(layer, key, value);
  }
  return layer;
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
  auth: {},
  allowlist: { payTo: [], domains: [] },
  telemetry: {
    payload: 'hash',
    redactKeys: [],
    // On by default, opt out with `config set telemetry.sink.enabled false`,
    // DO_NOT_TRACK=1 or X402_TELEMETRY=off. At the default `hash` payload level
    // no request or response body leaves the machine. See docs/telemetry.md.
    sink: { enabled: true, url: TELEMETRY_URL, batchSize: 50, batchIntervalMs: 10_000 },
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

/**
 * Config values that are switches, and must be booleans.
 *
 * `config set telemetry.sink.enabled on` stored the string `"on"`, which the
 * telemetry sink read as truthy and `status` read as off. `off` was truthy too.
 * The spellings an operator reaches for are mapped to a boolean, and anything
 * else is refused rather than stored as a switch nobody can read.
 */
export const BOOLEAN_KEYS: readonly string[] = ['telemetry.sink.enabled'];

const TRUE_WORDS = ['true', 'on', 'yes', '1'];
const FALSE_WORDS = ['false', 'off', 'no', '0'];

/** Coerce a value destined for `key` into the type that key must hold. */
export function normalizeConfigValue(key: string, value: JsonValue): JsonValue {
  if (AMOUNT_KEYS.includes(key) && isNumber(value)) return String(value);
  if (BOOLEAN_KEYS.includes(key) && !isBoolean(value)) {
    const word = String(value).trim().toLowerCase();
    if (TRUE_WORDS.includes(word)) return true;
    if (FALSE_WORDS.includes(word)) return false;
    throw new X402Error(ExitCode.GENERIC, `${key} is a switch: set it to true or false`);
  }
  return value;
}

/**
 * Coerce every amount in a config layer to a string.
 *
 * Runs on each raw JSON layer as it is read, before the layers are merged into
 * an `X402Config`, which is where a number-typed amount from an older file
 * would otherwise be mistaken for the string the type promises.
 */
export function normalizeAmounts(layer: JsonObject): JsonObject {
  const limits = layer.limits;
  if (!isJsonObject(limits)) return layer;
  const fixed = { ...limits };
  for (const key of AMOUNT_KEYS) {
    const leaf = key.split('.')[1]!;
    const value = fixed[leaf];
    if (isNumber(value)) fixed[leaf] = String(value);
  }
  return { ...layer, limits: fixed };
}

export type Json = JsonObject;

/** Merge two JSON objects; later wins, arrays and scalars replace. */
function mergeObjects(base: JsonValue | undefined, override: JsonObject): JsonObject {
  const out = isJsonObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] = isJsonObject(v) ? mergeObjects(out[k], v) : v;
  }
  return out;
}

/**
 * Deep merge where later sources win. Arrays replace, they do not concatenate.
 *
 * `T` is the shape of `base`; an undefined `override` returns `base` itself.
 */
export function mergeDeep<T extends JsonObject>(base: T, override: JsonObject | undefined): T {
  if (override === undefined) return base;
  const merged = mergeObjects(base, override);
  // SAFETY: `merged` keeps every key of `base` and replaces only the keys
  // `override` names. An override from a config file is unchecked JSON, so a
  // leaf it replaces can hold the wrong type; `loadConfig` therefore rejects a
  // scalar written over a group (`assertGroupsAreObjects`) and re-strings
  // amounts (`normalizeAmounts`), and `config set` refuses unknown keys
  // (`assertKnownConfigKey`) and coerces switches and amounts on write.
  return merged as T;
}

/** Resolve `env:NAME` strings anywhere in a JSON value. */
function resolveJson(value: JsonValue | undefined, env: NodeJS.ProcessEnv): JsonValue | undefined {
  if (isString(value) && value.startsWith('env:')) return env[value.slice(4)];
  if (Array.isArray(value)) {
    return value.map((v) => resolveJson(v, env)).filter((v): v is JsonValue => v !== undefined);
  }
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveJson(v, env);
    return out;
  }
  return value;
}

/**
 * Resolve `env:NAME` indirections against the environment at read time.
 * A missing variable resolves to undefined rather than the literal string,
 * so an unset token is a disabled feature, not a bogus credential.
 */
export function resolveEnv<T extends JsonValue | undefined>(
  value: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  // SAFETY: resolution replaces `env:` strings with the variable's value (a
  // string) or undefined, and rebuilds every object with the same keys, so
  // the result has `T`'s shape except that a string leaf set to an unset
  // `env:` reference reads as absent. Every key that takes an `env:`
  // reference (tokens, API keys, passphrases) is optional for that reason.
  return resolveJson(value, env) as T;
}

function readJsonFile(file: string): Json {
  let parsed: JsonValue;
  try {
    const raw = readFileSync(file, 'utf8');
    if (raw.trim() === '') return {};
    parsed = parseJson(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new X402Error(ExitCode.GENERIC, `cannot read config ${file}: ${message}`);
  }
  if (!isJsonObject(parsed)) {
    throw new X402Error(ExitCode.GENERIC, `cannot read config ${file}: not a JSON object`);
  }
  return parsed;
}

/**
 * Keys that hold a group of settings rather than a value.
 *
 * `config set telemetry on` wrote the string `"on"` over the whole `telemetry`
 * object. Every reader of `telemetry.sink` then threw `Cannot read properties
 * of undefined (reading 'enabled')`, `status` included, and nothing said which
 * key was wrong. A branch is any known key that has known keys below it.
 */
export function branchConfigKeys(): string[] {
  const branches = CONFIG_KEYS.filter((key) =>
    CONFIG_KEYS.some((other) => other.startsWith(`${key}.`)),
  );
  return [...new Set([...branches, ...OPEN_SUBTREES])];
}

/** The settable keys directly or indirectly below `branch`, leaves only. */
function leavesOf(branch: string): string[] {
  const below = CONFIG_KEYS.filter((key) => key.startsWith(`${branch}.`));
  return below.filter((key) => !below.some((other) => other.startsWith(`${key}.`)));
}

function branchHint(branch: string): string {
  const leaves = leavesOf(branch);
  return leaves.length > 0
    ? `Set one of its keys instead: ${leaves.join(', ')}.`
    : `Set a key below it instead, as ${branch}.<name>.`;
}

/** Refuse to write a plain value over a group of settings. */
export function assertGroupNotOverwritten(key: string, value: JsonValue): void {
  if (!branchConfigKeys().includes(key) || isJsonObject(value)) return;
  throw new X402Error(
    ExitCode.GENERIC,
    `"${key}" is a group of settings, not a value. ${branchHint(key)}`,
  );
}

/**
 * Name the first branch in a config file that holds a plain value, so a file
 * written by an older build fails with the key and the fix rather than a
 * TypeError from whichever reader reached it first.
 */
function assertGroupsAreObjects(layer: Json, source: string): void {
  for (const key of branchConfigKeys()) {
    const found = getPath(layer, key);
    if (found === undefined || isJsonObject(found)) continue;
    // A parent that is itself the wrong shape is reported on its own, and
    // `getPath` returns undefined below it.
    throw new X402Error(
      ExitCode.GENERIC,
      `config ${source}: "${key}" must be a group of settings, found ${JSON.stringify(found)}. ` +
        `Fix: rh-x402 config unset ${key}, then set what you meant. ${branchHint(key)}`,
    );
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

/** The raw layers a config was merged from, for `originsOf`. */
export interface ConfigLayers {
  env?: Json;
  user?: Json;
  project?: Json;
  flags?: Json;
}

/** Dotted key -> the layer its effective value came from. */
export interface ConfigOrigins {
  [path: string]: ValueOrigin;
}

export interface LoadedConfig {
  config: X402Config;
  sources: string[];
  /** Which layer each leaf came from, so a default is distinguishable. */
  origins: ConfigOrigins;
}

/**
 * defaults < endpoint env vars < ~/.x402/config.json < ./.x402rc < flags.
 * `env:` values resolved last.
 */
export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const sources: string[] = [];
  let merged: X402Config = DEFAULT_CONFIG;

  const layers: ConfigLayers = {};

  const envLayer = endpointEnvLayer();
  if (Object.keys(envLayer).length > 0) {
    merged = mergeDeep(merged, envLayer);
    layers.env = envLayer;
    sources.push('env');
  }

  const userFile = opts.file ? resolve(opts.file) : paths.config();
  if (existsSync(userFile)) {
    const user = normalizeAmounts(readJsonFile(userFile));
    assertGroupsAreObjects(user, userFile);
    merged = mergeDeep(merged, user);
    layers.user = user;
    sources.push(userFile);
  }

  const rc = join(opts.cwd ?? process.cwd(), '.x402rc');
  if (existsSync(rc)) {
    const project = normalizeAmounts(readJsonFile(rc));
    assertGroupsAreObjects(project, rc);
    merged = mergeDeep(merged, project);
    layers.project = project;
    sources.push(rc);
  }

  if (opts.overrides && Object.keys(opts.overrides).length > 0) {
    const flags = normalizeAmounts(opts.overrides);
    merged = mergeDeep(merged, flags);
    layers.flags = flags;
    sources.push('flags');
  }

  if (telemetryOptedOut()) {
    merged = mergeDeep(merged, { telemetry: { sink: { enabled: false } } });
  }

  return {
    config: resolveEnv(merged),
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

export function getPath(obj: JsonValue | undefined, dotted: string): JsonValue | undefined {
  let cursor = obj;
  for (const key of dotted.split('.')) {
    if (!isJsonObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

export function setPath(obj: Json, dotted: string, value: JsonValue): Json {
  const keys = dotted.split('.');
  let cursor = obj;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (isJsonObject(next)) {
      cursor = next;
    } else {
      const created: JsonObject = {};
      cursor[key] = created;
      cursor = created;
    }
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
  'wallet.path',
  'wallet.hidden',
  'wallet.backends',
  'limits',
  'limits.maxPerCall',
  'limits.dailyCap',
  'auth',
  'auth.apiKey',
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
  node: JsonValue | undefined = DEFAULT_CONFIG,
  prefix = '',
  out: string[] = [],
): string[] {
  if (!isJsonObject(node)) return out;
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
export interface UnsetResult {
  config: Json;
  removed: boolean;
}

export function unsetPath(obj: Json, dotted: string): UnsetResult {
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
    if (!isJsonObject(child)) return copy;
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
export type ValueOrigin = 'default' | 'env' | 'user' | 'project' | 'flag';

/**
 * Label each leaf of the effective config with the layer it came from.
 *
 * `config list` shows a merged object, so a defaulted value and one the user
 * chose look identical. That is how `wallet.backend: "ows"` reads as something
 * deliberate when nobody set it — and why an unset default can look like it is
 * "overriding" a key that was set somewhere else. Saying which layer won makes
 * that self-diagnosing.
 */
export function originsOf(layers: ConfigLayers): ConfigOrigins {
  const out: ConfigOrigins = {};
  const mark = (node: JsonValue | undefined, origin: ValueOrigin, prefix = ''): void => {
    if (!isJsonObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isJsonObject(value)) mark(value, origin, path);
      else out[path] = origin;
    }
  };
  // Later layers win, matching how the config itself is merged.
  for (const path of defaultedConfigKeys()) out[path] = 'default';
  mark(layers.env, 'env');
  mark(layers.user, 'user');
  mark(layers.project, 'project');
  mark(layers.flags, 'flag');
  return out;
}
