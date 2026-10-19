import { readFileSync } from 'node:fs';
import { X402Error, ExitCode, messageOf } from './errors.js';
import { isJsonObject, isNumber, parseJson, type JsonObject, type JsonValue } from './json.js';

export type Segment = string | number;

/**
 * Parse a dot/bracket path into segments.
 * `company.name` -> ['company','name'], `checks[0]` -> ['checks',0], `a[0].b` -> ['a',0,'b'].
 */
export function parsePath(path: string): Segment[] {
  if (path.length === 0) throw new X402Error(ExitCode.GENERIC, 'empty --data path');
  const segments: Segment[] = [];
  for (const part of path.split('.')) {
    if (part === '') throw new X402Error(ExitCode.GENERIC, `malformed --data path: ${path}`);
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) throw new X402Error(ExitCode.GENERIC, `malformed --data path: ${path}`);
    const [, name, indexes] = match;
    if (name) segments.push(name);
    else if (segments.length === 0)
      throw new X402Error(ExitCode.GENERIC, `--data path cannot start with an index: ${path}`);
    for (const idx of indexes!.matchAll(/\[(\d+)\]/g)) segments.push(Number(idx[1]));
  }
  return segments;
}

/**
 * Coerce a flag value. Values that parse as JSON scalars become that scalar;
 * everything else stays a string. `str:` forces string. `--data-strings` disables
 * coercion for the whole call.
 */
export function coerce(raw: string, strings = false): JsonValue {
  if (raw.startsWith('str:')) return raw.slice(4);
  if (strings) return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
    const n = Number(raw);
    // Reject numbers that would silently lose precision (long ids, big amounts).
    if (Number.isFinite(n) && String(n) === raw) return n;
    return raw;
  }
  return raw;
}

/** One level of a container being written into: an object key or an array index. */
type Container = JsonObject | JsonValue[];

function childOf(cursor: Container, key: Segment): JsonValue | undefined {
  if (Array.isArray(cursor)) return isNumber(key) ? cursor[key] : undefined;
  return isNumber(key) ? cursor[String(key)] : cursor[key];
}

function assign(cursor: Container, key: Segment, value: JsonValue): void {
  if (Array.isArray(cursor)) {
    // A string segment under an array cannot name an element; parsePath only
    // yields a number after a `[n]`, so this is an index in practice.
    cursor[Number(key)] = value;
    return;
  }
  cursor[String(key)] = value;
}

export function setDeep(root: JsonObject, segments: Segment[], value: JsonValue): void {
  let cursor: Container = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const wantArray = isNumber(segments[i + 1]!);
    const existing = childOf(cursor, key);
    if (wantArray && Array.isArray(existing)) {
      cursor = existing;
    } else if (!wantArray && isJsonObject(existing)) {
      cursor = existing;
    } else {
      const created: Container = wantArray ? [] : {};
      assign(cursor, key, created);
      cursor = created;
    }
  }
  assign(cursor, segments[segments.length - 1]!, value);
}

export interface DataFlag {
  path: string;
  value: string;
}

export interface BuildDataOptions {
  dataFlags?: DataFlag[];
  json?: string;
  stdin?: string | undefined;
  strings?: boolean;
}

export interface BuiltData {
  /** undefined when no data was supplied at all. */
  data: JsonValue | undefined;
  /** Sources that contributed, in application order. */
  sources: string[];
}

function parseJsonSource(input: string, label: string): JsonValue {
  try {
    return parseJson(input);
  } catch (err) {
    throw new X402Error(ExitCode.GENERIC, `invalid JSON from ${label}: ${messageOf(err)}`);
  }
}

/** Resolve `--json` argument forms: inline, `@file`, or `-` for stdin. */
export function resolveJsonArg(arg: string, stdin?: string): JsonValue {
  if (arg === '-') {
    if (stdin === undefined)
      throw new X402Error(ExitCode.GENERIC, '--json - given but stdin empty');
    return parseJsonSource(stdin, 'stdin');
  }
  if (arg.startsWith('@')) {
    const file = arg.slice(1);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      throw new X402Error(ExitCode.GENERIC, `cannot read ${file}: ${messageOf(err)}`);
    }
    return parseJsonSource(raw, file);
  }
  return parseJsonSource(arg, '--json');
}

/** Whether a value is a JSON object or array, the two shapes that merge. */
function isContainer(value: JsonValue | undefined): value is Container {
  return value !== null && typeof value === 'object';
}

/**
 * Merge the three data mechanisms. Later sources override earlier on key
 * collision: dot flags > --json > stdin.
 */
export function buildData(opts: BuildDataOptions): BuiltData {
  const sources: string[] = [];
  let data: JsonValue | undefined;

  if (opts.stdin !== undefined && opts.stdin.trim() !== '' && opts.json !== '-') {
    const trimmed = opts.stdin.trim();
    // Piped JSON is data. Piped anything else is a raw body, which callers may
    // still send verbatim; we keep it as a string rather than guessing.
    data =
      trimmed.startsWith('{') || trimmed.startsWith('[')
        ? parseJsonSource(trimmed, 'stdin')
        : trimmed;
    sources.push('stdin');
  }

  if (opts.json !== undefined) {
    const parsed = resolveJsonArg(opts.json, opts.stdin);
    // Spreading an array into an object gives index keys, which is what the
    // old merge did for `[..]` on either side; kept as-is.
    data = isContainer(data) && isContainer(parsed) ? { ...data, ...parsed } : parsed;
    sources.push('--json');
  }

  if (opts.dataFlags && opts.dataFlags.length > 0) {
    const base: JsonObject = isJsonObject(data) ? { ...data } : {};
    for (const flag of opts.dataFlags) {
      setDeep(base, parsePath(flag.path), coerce(flag.value, opts.strings));
    }
    data = base;
    sources.push('--data');
  }

  return { data, sources };
}

/**
 * Flatten data to query params using bracket notation:
 * `{company:{name:'Roundhouse'}}` -> `company[name]=Roundhouse`,
 * `{checks:['a','b']}` -> `checks[0]=a&checks[1]=b`.
 */
export function toQueryParams(data: JsonValue | undefined, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (data === undefined || data === null) return out;
  if (Array.isArray(data)) {
    data.forEach((v, i) =>
      out.push(...toQueryParams(v, prefix === '' ? String(i) : `${prefix}[${i}]`)),
    );
    return out;
  }
  if (isJsonObject(data)) {
    for (const [k, v] of Object.entries(data)) {
      out.push(...toQueryParams(v, prefix === '' ? k : `${prefix}[${k}]`));
    }
    return out;
  }
  out.push([prefix, String(data)]);
  return out;
}

export function topLevelKeys(data: JsonValue | undefined): string[] {
  if (isJsonObject(data)) return Object.keys(data).sort();
  return [];
}
