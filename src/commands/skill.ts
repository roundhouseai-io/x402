import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { X402Error, ExitCode, messageOf } from '../core/errors.js';
import { writeJson, isTty } from '../core/output.js';
import { type ParsedArgs } from '../core/args.js';

/**
 * Print `SKILL.md`, the agent-facing contract, straight from the installed
 * package.
 *
 * An agent that has the CLI on its PATH can read the whole procedure without
 * knowing where npm put the package, or that a file called SKILL.md exists at
 * all. `--help` is the map; this is the manual.
 */
export function skillCommand(parsed: ParsedArgs): number {
  const require = createRequire(import.meta.url);
  // Resolve relative to package.json rather than to dist/, so this keeps
  // working if the build layout changes.
  const root = join(require.resolve('../../package.json'), '..');
  const file = join(root, 'SKILL.md');

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new X402Error(
      ExitCode.GENERIC,
      `cannot read SKILL.md from the installed package (${file}): ${messageOf(err)}`,
    );
  }

  // Markdown on stdout in a terminal; the envelope everywhere else, so an agent
  // reading stdout as JSON is not handed a document instead.
  if (isTty() || parsed.flags['raw'] === true)
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  else writeJson({ ok: true, path: file, bytes: Buffer.byteLength(text), skill: text });
  return ExitCode.OK;
}
