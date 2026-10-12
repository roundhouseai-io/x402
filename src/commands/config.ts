import { X402Error, ExitCode } from '../core/errors.js';
import {
  loadConfig,
  readRawConfig,
  writeRawConfig,
  getPath,
  setPath,
  unsetPath,
  assertKnownConfigKey,
  assertGroupNotOverwritten,
  normalizeConfigValue,
} from '../core/config.js';
import { paths } from '../core/paths.js';
import { writeJson, writeErr, isTty } from '../core/output.js';
import { coerce } from '../core/data.js';
import { type ParsedArgs } from '../core/args.js';
import { REDACTED, redactConfig } from '../core/auth.js';
import { readStdin } from '../core/stdin.js';

const API_KEY_PATH = 'auth.apiKey';

/**
 * The value `config set` stores for `raw`.
 *
 * The API key gets three spellings: `env:NAME` (stored as the reference, read
 * at call time), `-` (read from stdin, so it never lands in argv or shell
 * history) and a literal (accepted, with a warning that argv is not private).
 */
async function valueFor(key: string, raw: string): Promise<unknown> {
  if (key === API_KEY_PATH) {
    if (raw.startsWith('env:')) return raw;
    if (raw === '-') {
      const piped = (await readStdin({ force: true }))?.trim();
      if (!piped) throw new X402Error(ExitCode.GENERIC, 'no key on stdin');
      return piped;
    }
    writeErr(
      'the key is on the command line, which shell history and `ps` can read. Prefer ' +
        '`config set auth.apiKey env:ROUNDHOUSE_API_KEY` or pipe it in with `-`.',
    );
    return raw;
  }
  // `env:NAME` stays a literal in the file and is resolved at read time, so
  // secrets never land in config.json. Everything else is coerced to its JSON
  // type and then normalised, so a money amount is stored as a string rather
  // than a number `parseUnits` cannot read.
  return raw.startsWith('env:') ? raw : normalizeConfigValue(key, coerce(raw));
}

/** Manage ~/.x402/config.json. `list` shows the effective, resolved config. */
export async function configCommand(parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0] ?? 'list';

  if (sub === 'list') {
    const loaded = loadConfig();
    const { sources, origins } = loaded;
    // Redacted before it is serialised: a `list` that echoes the key would put
    // it in every transcript the command is run in.
    const config = redactConfig(loaded.config);
    if (isTty()) {
      process.stdout.write(`# sources: ${sources.join(', ') || 'defaults only'}\n`);
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      // Naming the defaults is what stops a value nobody chose reading as a
      // deliberate setting that is "overriding" something.
      const defaults = Object.entries(origins)
        .filter(([, origin]) => origin === 'default')
        .map(([key]) => key);
      if (defaults.length > 0) {
        process.stdout.write(`\n# not set by you, showing defaults: ${defaults.join(', ')}\n`);
      }
    } else {
      writeJson({ ok: true, file: paths.config(), sources, config, origins });
    }
    return ExitCode.OK;
  }

  if (sub === 'get') {
    const key = parsed.positionals[1];
    if (!key) throw new X402Error(ExitCode.GENERIC, 'usage: rh-x402 config get <dotted.key>');
    const { config } = loadConfig();
    const found = getPath(config, key);
    const value = key === API_KEY_PATH && found ? REDACTED : found;
    if (isTty()) process.stdout.write(`${value === undefined ? '' : JSON.stringify(value)}\n`);
    else writeJson({ ok: value !== undefined, key, value: value ?? null });
    return value === undefined ? ExitCode.GENERIC : ExitCode.OK;
  }

  if (sub === 'set') {
    const key = parsed.positionals[1];
    const raw = parsed.positionals[2];
    if (!key || raw === undefined) {
      throw new X402Error(ExitCode.GENERIC, 'usage: rh-x402 config set <dotted.key> <value>');
    }
    // Refuse a key this build does not have. Writing it would report success
    // and change nothing, which is how `signer.backend` got set instead of
    // `wallet.backend` and every later command quietly used the default.
    assertKnownConfigKey(key);
    const value = await valueFor(key, raw);
    assertGroupNotOverwritten(key, value);
    const current = readRawConfig();
    writeRawConfig(setPath(current, key, value));
    // A literal API key is not echoed back. An `env:` reference is, because
    // naming the variable is the whole point and it is not a secret.
    const shown = key === API_KEY_PATH && !String(value).startsWith('env:') ? REDACTED : value;
    if (isTty()) process.stdout.write(`${key} = ${JSON.stringify(shown)}\n`);
    else writeJson({ ok: true, file: paths.config(), key, value: shown });
    return ExitCode.OK;
  }

  if (sub === 'unset') {
    const key = parsed.positionals[1];
    if (!key) throw new X402Error(ExitCode.GENERIC, 'usage: rh-x402 config unset <dotted.key>');
    // Deliberately not validated: the whole point is to remove a key that
    // should not be there, including one written before this check existed.
    const current = readRawConfig();
    const { config, removed } = unsetPath(current, key);
    writeRawConfig(config);
    if (isTty()) process.stdout.write(`${removed ? 'removed' : 'not set'} ${key}\n`);
    else writeJson({ ok: true, file: paths.config(), key, removed });
    return ExitCode.OK;
  }

  throw new X402Error(ExitCode.GENERIC, 'usage: rh-x402 config <get|set|unset|list>');
}
