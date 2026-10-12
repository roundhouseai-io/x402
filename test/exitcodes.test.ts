import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EXIT_CODE_TABLE,
  ExitCode,
  ExitCodeName,
  exitCodesMarkdown,
  exitCodesText,
} from '../src/core/errors.js';

/** A markdown table with its column padding removed, so prettier cannot make two tables differ. */
const rowsOf = (markdown: string): string[] =>
  markdown
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[\s|:-]+\|$/.test(line))
    .map((line) =>
      line
        .split('|')
        .map((cell) => cell.trim())
        .join('|'),
    );

describe('the exit-code table', () => {
  it('has a row for every code the CLI can exit with, and no other', () => {
    const declared = Object.values(ExitCode).sort((a, b) => a - b);
    expect(EXIT_CODE_TABLE.map((r) => r.code)).toEqual(declared);
  });

  it('agrees with the name each code carries in the JSON envelope', () => {
    for (const row of EXIT_CODE_TABLE) expect(ExitCodeName[row.code]).toBe(row.name);
  });

  it('says what to do next for every code', () => {
    for (const row of EXIT_CODE_TABLE) expect(row.next.length).toBeGreaterThan(5);
  });

  it('gives a wait that ran out of time its own code, 48', () => {
    expect(ExitCode.WAIT_TIMEOUT).toBe(48);
    expect(ExitCodeName[48]).toBe('wait_timeout');
  });

  it('prints every code in the terminal form', () => {
    const text = exitCodesText();
    for (const row of EXIT_CODE_TABLE) expect(text).toContain(row.name);
  });
});

describe('the documents that copy it', () => {
  it('carries the same table in SKILL.md, row for row', () => {
    const skill = readFileSync('SKILL.md', 'utf8');
    const expected = rowsOf(exitCodesMarkdown());
    const actual = rowsOf(skill);
    for (const row of expected) expect(actual).toContain(row);
  });

  it('lists 48 in docs/exit-codes.md and no longer calls it unassigned', () => {
    const doc = readFileSync('docs/exit-codes.md', 'utf8');
    expect(doc).toContain('`wait_timeout`');
    expect(doc).not.toMatch(/Codes [^\n]*\b48\b[^\n]*unassigned/);
  });
});
