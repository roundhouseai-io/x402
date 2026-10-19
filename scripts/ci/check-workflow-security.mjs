#!/usr/bin/env node
/**
 * Reject GitHub Actions patterns that are dangerous once the repo is public.
 *
 * Adapted from ECC's `validate-workflow-security.js`, cut down to the rules
 * that matter for this repo. A public repo takes pull requests from forks; a
 * workflow that runs fork code with a write token or with the npm token can
 * publish a malicious version of a tool that signs payments.
 *
 *   1. Every workflow declares a top-level `permissions:` block (least privilege).
 *   2. No `permissions: write-all`.
 *   3. `pull_request_target` / `workflow_run` never check out the PR head.
 *   4. No untrusted event text (PR title/body, issue/comment body, head ref)
 *      interpolated straight into a `run:` script — pass it through `env:`.
 *
 * Usage: node scripts/ci/check-workflow-security.mjs [workflows-dir]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.github/workflows');
const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .sort()
  : [];

const UNTRUSTED =
  /\$\{\{\s*github\.(?:event\.(?:pull_request\.(?:title|body|head\.ref|head\.label)|issue\.(?:title|body)|comment\.body|review\.body|review_comment\.body|head_commit\.message|commits\[\d+\]\.message)|head_ref)\s*\}\}/;
const HEAD_CHECKOUT =
  /\$\{\{\s*github\.event\.(?:pull_request\.head\.(?:ref|sha|repo\.full_name)|workflow_run\.head_(?:branch|sha|repository[\w.]*))\s*\}\}|refs\/pull\//;

const errors = [];
for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf8');
  if (!/^permissions:/m.test(text)) errors.push(`${file}: no top-level permissions block`);
  if (/permissions:\s*["']?write-all/.test(text)) errors.push(`${file}: permissions: write-all`);

  const privileged = /^\s*(pull_request_target|workflow_run)\s*:/m.test(text);
  if (privileged && HEAD_CHECKOUT.test(text)) {
    errors.push(`${file}: privileged trigger checks out untrusted PR code`);
  }

  // Walk `run:` blocks (inline and `|` / `>` block scalars) for injection.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body = [m[2]];
    if (/^[|>]/.test(m[2].trim())) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() !== '' && l.length - l.trimStart().length <= indent) break;
        body.push(l);
      }
    }
    if (UNTRUSTED.test(body.join('\n'))) {
      errors.push(
        `${file}:${i + 1}: untrusted github.event text interpolated into run:; pass it via env:`,
      );
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log(`workflow security: ${files.length} workflow(s) checked`);
