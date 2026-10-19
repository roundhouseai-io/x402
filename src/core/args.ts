import { X402Error, ExitCode } from './errors.js';
import type { DataFlag } from './data.js';
import type { HeaderMap } from './http.js';
import { isNumber, isString } from './json.js';

export type FlagKind = 'string' | 'number' | 'boolean' | 'list';

/**
 * Flag table. Explicit kinds keep `--dry-run <url>` from swallowing the URL,
 * which is the classic hand-rolled-parser bug.
 */
export interface FlagSpec {
  kind: FlagKind;
  alias?: string;
}

export const FLAGS = new Map<string, FlagSpec>([
  // request
  ['method', { kind: 'string', alias: 'X' }],
  ['header', { kind: 'list', alias: 'H' }],
  ['timeout', { kind: 'number' }],
  ['out', { kind: 'string' }],
  ['raw', { kind: 'boolean' }],
  ['json', { kind: 'string' }],
  ['form', { kind: 'boolean' }],
  ['body-always', { kind: 'boolean' }],
  ['data-strings', { kind: 'boolean' }],
  // payment
  ['wallet', { kind: 'string', alias: 'w' }],
  ['max', { kind: 'string' }],
  ['budget', { kind: 'string' }],
  ['chain', { kind: 'string' }],
  ['dry-run', { kind: 'boolean' }],
  ['receipt-out', { kind: 'string' }],
  ['no-cache', { kind: 'boolean' }],
  ['signer', { kind: 'string' }],
  // telemetry
  ['telemetry-payload', { kind: 'string' }],
  // output / global
  ['config', { kind: 'string' }],
  ['help', { kind: 'boolean', alias: 'h' }],
  ['version', { kind: 'boolean', alias: 'V' }],
  ['quiet', { kind: 'boolean', alias: 'q' }],
  ['verbose', { kind: 'boolean', alias: 'v' }],
  // history
  ['since', { kind: 'string' }],
  ['until', { kind: 'string' }],
  ['paid-only', { kind: 'boolean' }],
  ['sum', { kind: 'boolean' }],
  ['by', { kind: 'string' }],
  ['limit', { kind: 'number' }],
  // discover
  ['capability', { kind: 'string' }],
  // serve
  ['host', { kind: 'string' }],
  ['port', { kind: 'number' }],
  ['mcp', { kind: 'boolean' }],
  ['i-understand-this-exposes-spending', { kind: 'boolean' }],
  ['budget-daily', { kind: 'string' }],
  ['max-per-call', { kind: 'string' }],
  ['capabilities', { kind: 'string' }],
  ['admin', { kind: 'boolean' }],
  // verify / pay
  ['receipt', { kind: 'string' }],
  ['file', { kind: 'string' }],
  // signer / keystore
  ['key-file', { kind: 'string' }],
  ['keystore', { kind: 'string' }],
  ['replace', { kind: 'boolean' }],

  // guided wallet setup (`wallet create`)
  ['path', { kind: 'string' }],
  ['name', { kind: 'string' }],
  ['vault', { kind: 'string' }],
  ['expires', { kind: 'string' }],
  ['address', { kind: 'string' }],
  ['policy', { kind: 'boolean' }],
  ['no-policy', { kind: 'boolean' }],
  ['install', { kind: 'boolean' }],
  ['install-global', { kind: 'boolean' }],

  // status / setup
  ['min-balance', { kind: 'string' }],
  ['daily-cap', { kind: 'string' }],
  ['telemetry', { kind: 'string' }],
  ['org-key', { kind: 'string' }],
  ['key-env', { kind: 'string' }],
  ['fund-timeout', { kind: 'string' }],
  ['yes', { kind: 'boolean', alias: 'y' }],
  ['print-key', { kind: 'boolean' }],
  ['repay', { kind: 'boolean' }],

  // wallet balance --wait
  ['wait', { kind: 'boolean' }],
  ['min', { kind: 'string' }],

  // discover --policy
  ['spot-factor', { kind: 'string' }],

  // help exit-codes
  ['markdown', { kind: 'boolean' }],
]);

/**
 * Flags whose kind differs by command.
 *
 * `--json` takes a value on `call` (`--json '{"q":1}'`, `@file`, `-`), but on
 * `status` and `setup` it is a switch meaning "print JSON". One name, two jobs:
 * the flag table is flat, so without this `rh-x402 status --json` would either
 * swallow the next argument or fail with "needs a value".
 */
const COMMAND_FLAG_KINDS = new Map<string, Map<string, { kind: FlagKind }>>([
  ['status', new Map([['json', { kind: 'boolean' }]])],
  ['setup', new Map([['json', { kind: 'boolean' }]])],
  ['help', new Map([['json', { kind: 'boolean' }]])],
  // A duration (`30m`) here, a number of seconds for a request everywhere else.
  ['wallet', new Map([['timeout', { kind: 'string' }]])],
]);

/** Short alias -> long flag name, e.g. `X` -> `method`. */
const ALIASES = new Map<string, string>();
for (const [name, spec] of FLAGS) if (spec.alias) ALIASES.set(spec.alias, name);

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | number | boolean | string[]>;
  dataFlags: DataFlag[];
}

const looksLikeUrl = (s: string) => /^(https?:\/\/|x402:)/i.test(s);

/** Commands that exist. Used to decide whether argv[0] is a command or a URL. */
export const COMMANDS = [
  'call',
  'probe',
  'pay',
  'verify',
  'wallet',
  'history',
  'discover',
  'serve',
  'signer',
  'config',
  'skill',
  'status',
  'setup',
  'help',
  'version',
] as const;

export type Command = (typeof COMMANDS)[number];

export function isCommand(word: string): word is Command {
  return COMMANDS.some((command) => command === word);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: ParsedArgs['flags'] = {};
  const dataFlags: DataFlag[] = [];
  const positionals: string[] = [];
  let sawTerminator = false;
  // The command is argv[0] when it is one. Flags can only be read per command
  // for the few that change meaning, so a command given after a flag keeps the
  // global table.
  const kinds = COMMAND_FLAG_KINDS.get(argv[0] ?? '');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (sawTerminator) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      sawTerminator = true;
      continue;
    }

    if (arg.startsWith('--data.') || arg.startsWith('--data[')) {
      const body = arg.slice('--data'.length).replace(/^\./, '');
      const eq = body.indexOf('=');
      if (eq >= 0) {
        dataFlags.push({ path: body.slice(0, eq), value: body.slice(eq + 1) });
      } else {
        const next = argv[++i];
        if (next === undefined) throw new X402Error(ExitCode.GENERIC, `${arg} needs a value`);
        dataFlags.push({ path: body, value: next });
      }
      continue;
    }

    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length > 1 && !looksLikeUrl(arg))) {
      const isLong = arg.startsWith('--');
      let name = isLong ? arg.slice(2) : arg.slice(1);
      let inline: string | undefined;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        inline = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (!isLong) name = ALIASES.get(name) ?? name;

      let negated = false;
      let spec = kinds?.get(name) ?? FLAGS.get(name);
      if (!spec && name.startsWith('no-')) {
        const positive = name.slice(3);
        const positiveSpec = FLAGS.get(positive);
        if (positiveSpec?.kind === 'boolean') {
          spec = positiveSpec;
          name = positive;
          negated = true;
        }
      }
      if (!spec) throw new X402Error(ExitCode.GENERIC, `unknown flag: ${arg}`);

      if (spec.kind === 'boolean') {
        flags[name] = negated ? false : inline === undefined ? true : inline !== 'false';
        continue;
      }

      const value = inline ?? argv[++i];
      if (value === undefined) throw new X402Error(ExitCode.GENERIC, `${arg} needs a value`);
      if (spec.kind === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new X402Error(ExitCode.GENERIC, `${arg} needs a number`);
        flags[name] = n;
      } else if (spec.kind === 'list') {
        const prior = flags[name];
        const existing = Array.isArray(prior) ? prior : [];
        flags[name] = [...existing, value];
      } else {
        flags[name] = value;
      }
      continue;
    }

    positionals.push(arg);
  }

  let command: string | undefined;
  const first = positionals[0];
  if (first !== undefined) {
    if (isCommand(first)) {
      command = positionals.shift();
    } else if (looksLikeUrl(first)) {
      // `rh-x402 <url>` is sugar for `rh-x402 call <url>`.
      command = 'call';
    }
  }

  return { command, positionals, flags, dataFlags };
}

export function str(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags[name];
  return isString(v) ? v : undefined;
}

export function num(flags: ParsedArgs['flags'], name: string): number | undefined {
  const v = flags[name];
  return isNumber(v) ? v : undefined;
}

export function bool(flags: ParsedArgs['flags'], name: string): boolean {
  return flags[name] === true;
}

export function list(flags: ParsedArgs['flags'], name: string): string[] {
  const v = flags[name];
  return Array.isArray(v) ? v : [];
}

/** Parse repeatable `-H "Name: value"` into a header map. */
export function parseHeaders(raw: string[]): HeaderMap {
  const out: HeaderMap = {};
  for (const item of raw) {
    const idx = item.indexOf(':');
    if (idx <= 0) throw new X402Error(ExitCode.GENERIC, `malformed --header: ${item}`);
    out[item.slice(0, idx).trim()] = item.slice(idx + 1).trim();
  }
  return out;
}
