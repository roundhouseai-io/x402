import { X402Error, ExitCode } from '../core/errors.js';
import {
  loadConfig,
  readRawConfig,
  writeRawConfig,
  getPath,
  setPath,
  unsetPath,
  assertKnownConfigKey,
} from '../core/config.js';
import { paths } from '../core/paths.js';
import { writeJson, isTty } from '../core/output.js';
import { coerce } from '../core/data.js';
import { type ParsedArgs } from '../core/args.js';

/** Manage ~/.x402/config.json. `list` shows the effective, resolved config. */
export function configCommand(parsed: ParsedArgs): number {
  const sub = parsed.positionals[0] ?? 'list';

  if (sub === 'list') {
    const { config, sources, origins } = loadConfig();
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
    const value = getPath(config, key);
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
    // `env:NAME` stays a literal in the file and is resolved at read time, so
    // secrets never land in config.json.
    const value = raw.startsWith('env:') ? raw : coerce(raw);
    const current = readRawConfig();
    writeRawConfig(setPath(current, key, value));
    if (isTty()) process.stdout.write(`${key} = ${JSON.stringify(value)}\n`);
    else writeJson({ ok: true, file: paths.config(), key, value });
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
