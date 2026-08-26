import { describe, it, expect } from 'vitest';
import { parsePath, coerce, buildData, toQueryParams, setDeep } from '../src/core/data.js';

describe('parsePath', () => {
  it('splits objects and array indexes', () => {
    expect(parsePath('company.name')).toEqual(['company', 'name']);
    expect(parsePath('checks[0]')).toEqual(['checks', 0]);
    expect(parsePath('a[0].b[10]')).toEqual(['a', 0, 'b', 10]);
  });

  it('rejects malformed paths', () => {
    expect(() => parsePath('')).toThrow();
    expect(() => parsePath('a..b')).toThrow();
    expect(() => parsePath('[0]')).toThrow();
  });
});

describe('coerce', () => {
  it('coerces JSON scalars', () => {
    expect(coerce('10')).toBe(10);
    expect(coerce('true')).toBe(true);
    expect(coerce('false')).toBe(false);
    expect(coerce('null')).toBeNull();
    expect(coerce('0.05')).toBe(0.05);
    expect(coerce('Amplify Limited')).toBe('Amplify Limited');
  });

  it('keeps strings when asked', () => {
    expect(coerce('10', true)).toBe('10');
    expect(coerce('str:10001')).toBe('10001');
    expect(coerce('str:10001', true)).toBe('10001');
  });

  it('refuses to lose precision on long ids', () => {
    expect(coerce('00123')).toBe('00123');
    expect(coerce('123456789012345678901234567890')).toBe('123456789012345678901234567890');
  });
});

describe('buildData', () => {
  it('builds the spec example', () => {
    const { data } = buildData({
      dataFlags: [
        { path: 'company.name', value: 'Amplify Limited' },
        { path: 'company.jurisdiction', value: 'GB' },
        { path: 'checks[0]', value: 'sanctions' },
        { path: 'checks[1]', value: 'pep' },
        { path: 'limit', value: '10' },
        { path: 'deep', value: 'true' },
      ],
    });
    expect(data).toEqual({
      company: { name: 'Amplify Limited', jurisdiction: 'GB' },
      checks: ['sanctions', 'pep'],
      limit: 10,
      deep: true,
    });
  });

  it('applies precedence: dot flags > --json > stdin', () => {
    const { data, sources } = buildData({
      stdin: '{"a":"stdin","b":"stdin","c":"stdin"}',
      json: '{"a":"json","b":"json"}',
      dataFlags: [{ path: 'a', value: 'flag' }],
    });
    expect(data).toEqual({ a: 'flag', b: 'json', c: 'stdin' });
    expect(sources).toEqual(['stdin', '--json', '--data']);
  });

  it('returns undefined when nothing was supplied', () => {
    expect(buildData({}).data).toBeUndefined();
  });

  it('keeps non-JSON stdin as a raw body', () => {
    expect(buildData({ stdin: 'plain text' }).data).toBe('plain text');
  });
});

describe('toQueryParams', () => {
  it('uses bracket notation for nesting', () => {
    expect(
      toQueryParams({
        company: { name: 'Amplify Limited' },
        checks: ['sanctions', 'pep'],
        limit: 10,
      }),
    ).toEqual([
      ['company[name]', 'Amplify Limited'],
      ['checks[0]', 'sanctions'],
      ['checks[1]', 'pep'],
      ['limit', '10'],
    ]);
  });
});

describe('setDeep', () => {
  it('creates arrays for numeric segments and objects otherwise', () => {
    const root: Record<string, unknown> = {};
    setDeep(root, ['a', 0, 'b'], 'x');
    expect(root).toEqual({ a: [{ b: 'x' }] });
  });
});
