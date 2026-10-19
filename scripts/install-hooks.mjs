#!/usr/bin/env node
// Point git at .githooks/ so the anti-slop pre-commit hook runs. Called from
// `npm install` via `prepare`, so it must be a silent no-op anywhere but the
// root of a git checkout of this repository: in a tarball install, a git
// dependency's temp clone, or a directory nested inside someone else's repo it
// changes nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();
if (!existsSync(join(cwd, '.githooks', 'pre-commit'))) process.exit(0);

let top;
try {
  top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  process.exit(0);
}
if (realpathSync(top) !== realpathSync(cwd)) process.exit(0);

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // Never fail an install over a convenience.
}
