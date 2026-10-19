#!/usr/bin/env node
/**
 * Fail on invisible and bidirectional-control characters in tracked text files.
 *
 * Adapted from ECC's `check-unicode-safety.js`. This repo is read by agents as
 * well as humans (SKILL.md is the agent contract, and `rh-x402 skill` prints
 * it), so a zero-width or Tag-block character is a prompt-injection vector,
 * and a bidi override in source is the "Trojan Source" attack (CVE-2021-42574):
 * code that reviews as one thing and compiles as another.
 *
 * Unlike ECC this does not ban emoji or typographic punctuation. The docs use
 * em dashes, arrows and middle dots on purpose; none of those can hide text.
 *
 * Usage: node scripts/ci/check-unicode-safety.mjs [root]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.sh',
]);

/** [from, to, label] inclusive code point ranges that are never legitimate here. */
const DANGEROUS = [
  [0x200b, 0x200d, 'zero-width space/joiner'],
  [0x2060, 0x2064, 'word joiner / invisible operator'],
  [0xfeff, 0xfeff, 'zero-width no-break space (BOM)'],
  [0x202a, 0x202e, 'bidi embedding/override'],
  [0x2066, 0x2069, 'bidi isolate'],
  [0x200e, 0x200f, 'bidi mark'],
  [0x061c, 0x061c, 'arabic letter mark'],
  [0x180e, 0x180e, 'mongolian vowel separator'],
  [0x115f, 0x1160, 'hangul filler'],
  [0x3164, 0x3164, 'hangul filler'],
  [0xfe00, 0xfe0f, 'variation selector'],
  [0xe0000, 0xe007f, 'tag character (ASCII smuggling)'],
  [0xe0100, 0xe01ef, 'variation selector supplement'],
];

function classify(cp) {
  for (const [from, to, label] of DANGEROUS) if (cp >= from && cp <= to) return label;
  return undefined;
}

function trackedFiles() {
  // Tracked files only, so node_modules, dist and coverage are never scanned.
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return out.split('\0').filter((f) => f !== '' && TEXT_EXTENSIONS.has(extname(f).toLowerCase()));
}

let failures = 0;
for (const file of trackedFiles()) {
  // Vendored upstream lint rules are not ours to edit.
  if (file.startsWith('tools/oxlint/anti-slop/')) continue;
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  let line = 1;
  let col = 0;
  for (const ch of text) {
    col += 1;
    if (ch === '\n') {
      line += 1;
      col = 0;
      continue;
    }
    const cp = ch.codePointAt(0);
    const label = classify(cp);
    if (label) {
      failures += 1;
      const hex = cp.toString(16).toUpperCase().padStart(4, '0');
      console.error(`${file}:${line}:${col}: U+${hex} ${label}`);
    }
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} dangerous invisible/bidi character(s). Remove them, or explain in the PR.`,
  );
  process.exit(1);
}
console.log('unicode safety: no invisible or bidi-control characters in tracked text files');
