#!/usr/bin/env node
/**
 * Fail on user-specific absolute paths in tracked files.
 *
 * Adapted from ECC's `validate-no-personal-paths.js`. A path like
 * `/Users/alice/...` in a doc, a test fixture or a snapshot leaks a username
 * and a machine layout, and usually means a local artefact was committed by
 * accident. Placeholders (`/Users/you`, `/home/user`, ...) are allowed, as is
 * `/home/runner`, the GitHub Actions home directory.
 *
 * Usage: node scripts/ci/check-no-personal-paths.mjs [root]
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

const PLACEHOLDERS = new Set([
  'example',
  'me',
  'user',
  'username',
  'you',
  'yourname',
  'your-name',
  'yourusername',
  'your-username',
  'runner',
  'node',
  'agent',
  'alice',
  'bob',
]);

const PATTERNS = [
  /\/Users\/([A-Za-z][A-Za-z0-9._-]*)/g,
  /\/home\/([A-Za-z][A-Za-z0-9._-]*)/g,
  /[A-Za-z]:\\\\?Users\\\\?([A-Za-z][A-Za-z0-9._-]*)/g,
];

// Lockfiles carry registry URLs, not paths; this script names the patterns.
const SKIP = new Set(['package-lock.json', 'scripts/ci/check-no-personal-paths.mjs']);

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((f) => f !== '' && !SKIP.has(f) && TEXT_EXTENSIONS.has(extname(f).toLowerCase()));

let failures = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((content, i) => {
    for (const pattern of PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(content)) !== null) {
        if (PLACEHOLDERS.has(m[1].toLowerCase())) continue;
        failures += 1;
        console.error(`${file}:${i + 1}: personal path "${m[0]}"`);
      }
    }
  });
}

if (failures > 0) {
  console.error(`\n${failures} personal path(s). Use a placeholder such as /Users/you or ~/.`);
  process.exit(1);
}
console.log('personal paths: none in tracked files');
