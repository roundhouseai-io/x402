import { X402Error, ExitCode } from '../core/errors.js';
import { loadConfig, readRawConfig, writeRawConfig, getPath, setPath } from '../core/config.js';
import { paths } from '../core/paths.js';
import { writeJson, isTty } from '../core/output.js';
import { coerce } from '../core/data.js';
import { type ParsedArgs } from '../core/args.js';

/** Manage ~/.x402/config.json. `list` shows the effective, resolved config. */
export function configCommand(parsed: ParsedArgs): number {
  const sub = parsed.positionals[0] ?? 'list';

  if (sub === 'list') {
    const { config, sources } = loadConfig();
    if (isTty()) {
      process.stdout.write(`# sources: ${sources.join(', ') || 'defaults only'}\n`);
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    } else {
      writeJson({ ok: true, file: paths.config(), sources, config });
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
    // `env:NAME` stays a literal in the file and is resolved at read time, so
    // secrets never land in config.json.
    const value = raw.startsWith('env:') ? raw : coerce(raw);
    const current = readRawConfig();
    writeRawConfig(setPath(current, key, value));
    if (isTty()) process.stdout.write(`${key} = ${JSON.stringify(value)}\n`);
    else writeJson({ ok: true, file: paths.config(), key, value });
    return ExitCode.OK;
  }

  throw new X402Error(ExitCode.GENERIC, 'usage: rh-x402 config <get|set|list>');
}
