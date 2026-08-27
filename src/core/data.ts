import { readFileSync } from 'node:fs';
import { X402Error, ExitCode } from './errors.js';

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
export function coerce(raw: string, strings = false): unknown {
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

export function setDeep(root: Record<string, unknown>, segments: Segment[], value: unknown): void {
  let cursor: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const nextKey = segments[i + 1]!;
    const wantArray = typeof nextKey === 'number';
    const existing = (cursor as Record<string | number, unknown>)[key as never];
    let child = existing;
    if (wantArray ? !Array.isArray(existing) : typeof existing !== 'object' || existing === null) {
      child = wantArray ? [] : {};
      (cursor as Record<string | number, unknown>)[key as never] = child as never;
    }
    cursor = child as Record<string, unknown> | unknown[];
  }
  const last = segments[segments.length - 1]!;
  (cursor as Record<string | number, unknown>)[last as never] = value as never;
}

export interface DataFlag {
  path: string;
  value: string;
}

export interface BuildDataOptions {
  dataFlags?: DataFlag[];
  json?: string;
  stdin?: string;
  strings?: boolean;
}

export interface BuiltData {
  /** undefined when no data was supplied at all. */
  data: unknown;
  /** Sources that contributed, in application order. */
  sources: string[];
}

function parseJsonSource(input: string, label: string): unknown {
  try {
    return JSON.parse(input);
  } catch (err) {
    throw new X402Error(ExitCode.GENERIC, `invalid JSON from ${label}: ${(err as Error).message}`);
  }
}

/** Resolve `--json` argument forms: inline, `@file`, or `-` for stdin. */
export function resolveJsonArg(arg: string, stdin?: string): unknown {
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
      throw new X402Error(ExitCode.GENERIC, `cannot read ${file}: ${(err as Error).message}`);
    }
    return parseJsonSource(raw, file);
  }
  return parseJsonSource(arg, '--json');
}

/**
 * Merge the three data mechanisms. Later sources override earlier on key
 * collision: dot flags > --json > stdin.
 */
export function buildData(opts: BuildDataOptions): BuiltData {
  const sources: string[] = [];
  let data: unknown;

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
    data =
      typeof data === 'object' && data !== null && typeof parsed === 'object' && parsed !== null
        ? { ...(data as Record<string, unknown>), ...(parsed as Record<string, unknown>) }
        : parsed;
    sources.push('--json');
  }

  if (opts.dataFlags && opts.dataFlags.length > 0) {
    const base: Record<string, unknown> =
      typeof data === 'object' && data !== null && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>) }
        : {};
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
export function toQueryParams(data: unknown, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (data === undefined || data === null) return out;
  if (Array.isArray(data)) {
    data.forEach((v, i) =>
      out.push(...toQueryParams(v, prefix === '' ? String(i) : `${prefix}[${i}]`)),
    );
    return out;
  }
  if (typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out.push(...toQueryParams(v, prefix === '' ? k : `${prefix}[${k}]`));
    }
    return out;
  }
  out.push([prefix, String(data)]);
  return out;
}

export function topLevelKeys(data: unknown): string[] {
  if (data && typeof data === 'object' && !Array.isArray(data)) return Object.keys(data).sort();
  return [];
}
