import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  isBigInt,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  numberField,
  objectField,
  parseJson,
  stringField,
} from '../src/core/json.js';
import { errnoCode, exitCodeOf, ExitCode, messageOf, X402Error } from '../src/core/errors.js';
import { decodePaymentHeader, decodeSettlement, isPaymentPayload } from '../src/core/eip3009.js';
import { readKeystore } from '../src/core/keystore.js';
import { isLedgerRecord, readRecords, isGroupKey } from '../src/core/ledger.js';
import { readAuth } from '../src/core/authcache.js';
import { isCallerToken, loadTokens } from '../src/serve/tokens.js';
import { isJsonRpcRequest } from '../src/serve/mcp.js';
import { isCommand } from '../src/core/args.js';
import { isBuiltinBackend } from '../src/core/signers/index.js';
import { paths } from '../src/core/paths.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-guards-'));
  process.env.X402_HOME = home;
});
afterEach(() => {
  delete process.env.X402_HOME;
  rmSync(home, { recursive: true, force: true });
});

const b64 = (value: JsonValue): string => Buffer.from(JSON.stringify(value)).toString('base64');

describe('json vocabulary', () => {
  it('parses JSON and throws on malformed text like JSON.parse', () => {
    expect(parseJson('{"a":[1,"b",null,true]}')).toEqual({ a: [1, 'b', null, true] });
    expect(() => parseJson('{nope')).toThrow(SyntaxError);
  });

  it('tells objects from arrays and null', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('x')).toBe(false);
  });

  it('narrows scalars', () => {
    expect([isString('a'), isString(1)]).toEqual([true, false]);
    expect([isNumber(1), isNumber('1')]).toEqual([true, false]);
    expect([isBoolean(false), isBoolean(0)]).toEqual([true, false]);
    expect([isBigInt(1n), isBigInt(1)]).toEqual([true, false]);
  });

  it('reads typed fields and ignores ones of the wrong type', () => {
    const obj = { s: 'x', n: 2, o: { k: 1 }, wrong: true };
    expect(stringField(obj, 's')).toBe('x');
    expect(stringField(obj, 'n')).toBeUndefined();
    expect(numberField(obj, 'n')).toBe(2);
    expect(numberField(obj, 's')).toBeUndefined();
    expect(objectField(obj, 'o')).toEqual({ k: 1 });
    expect(objectField(obj, 'wrong')).toBeUndefined();
  });
});

describe('error helpers', () => {
  it('reads a message and exit code from anything thrown', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf('plain')).toBe('plain');
    expect(exitCodeOf(new X402Error(ExitCode.OVER_MAX, 'too much'))).toBe(ExitCode.OVER_MAX);
    expect(exitCodeOf(new Error('x'))).toBe(ExitCode.GENERIC);
  });

  it('reads a system error code only off an Error that has a string one', () => {
    expect(errnoCode(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(errnoCode(new Error('no code'))).toBeUndefined();
    expect(errnoCode({ code: 'ENOENT' })).toBeUndefined();
  });
});

describe('payment header guards', () => {
  const authorization = {
    from: '0x01',
    to: '0x02',
    value: '1',
    validAfter: '0',
    validBefore: '9',
    nonce: '0x00',
  };

  it('accepts the v1 and v2 shapes this client writes', () => {
    const v1 = {
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { signature: '0x1', authorization },
    };
    const v2 = {
      x402Version: 2,
      accepted: { scheme: 'exact' },
      payload: { signature: '0x1', authorization },
    };
    expect(isPaymentPayload(v1)).toBe(true);
    expect(isPaymentPayload(v2)).toBe(true);
    expect(decodePaymentHeader(b64(v2)).x402Version).toBe(2);
  });

  it('refuses a header that is not a payment payload', () => {
    expect(isPaymentPayload({ x402Version: 3, payload: { signature: '0x1', authorization } })).toBe(
      false,
    );
    expect(
      isPaymentPayload({ x402Version: 1, scheme: 'exact', network: 'base', payload: {} }),
    ).toBe(false);
    expect(() => decodePaymentHeader(b64({ hello: 'world' }))).toThrow(
      /not an x402 payment payload/,
    );
  });

  it('drops a settlement receipt whose documented fields have the wrong type', () => {
    expect(decodeSettlement(JSON.stringify({ success: true, transaction: '0xabc' }))?.success).toBe(
      true,
    );
    expect(decodeSettlement(JSON.stringify({ success: 'yes' }))).toBeUndefined();
    expect(decodeSettlement(JSON.stringify([1, 2]))).toBeUndefined();
  });
});

describe('files read back from disk', () => {
  it('refuses a keystore with a malformed entry rather than dropping it', () => {
    const file = join(home, 'keystore.json');
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ name: 'half' }] }), {
      mode: 0o600,
    });
    expect(() => readKeystore(file)).toThrow(/not in the scrypt\/aes-256-gcm format/);
  });

  it('skips ledger lines that are not whole records', () => {
    const good = {
      id: 'r1',
      ts: new Date().toISOString(),
      url: 'https://api.example.com/',
      method: 'GET',
      wallet: null,
      request: { bytes: 0 },
      payment: { paid: false, amount: '0' },
      response: { status: 200, bytes: 0, latencyMs: 1 },
      exitCode: 0,
      agent: {},
    };
    const file = join(home, 'ledger.jsonl');
    writeFileSync(file, `${JSON.stringify(good)}\n${JSON.stringify({ id: 'r2' })}\n[1]\n`);
    expect(readRecords(file).map((r) => r.id)).toEqual(['r1']);
    expect(isLedgerRecord({ id: 'x' })).toBe(false);
  });

  it('treats a cached authorization missing a field as a miss', () => {
    mkdirSync(paths.authcache(), { recursive: true });
    writeFileSync(
      join(paths.authcache(), 'k1.json'),
      JSON.stringify({ key: 'k1', validBefore: 9e9 }),
    );
    expect(readAuth('k1')).toBeUndefined();
  });

  it('drops caller tokens that are not the stored shape', () => {
    const file = join(home, 'tokens.json');
    const ok = { name: 'a', hash: 'h', createdAt: 'now' };
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tokens: [ok, { name: 'b' }, { ...ok, name: 'c', admin: 'yes' }],
      }),
    );
    expect(loadTokens(file).tokens.map((t) => t.name)).toEqual(['a']);
    expect(isCallerToken({ ...ok, capabilities: ['lei', 3] })).toBe(false);
  });
});

describe('name guards', () => {
  it('recognises JSON-RPC requests', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(true);
    expect(isJsonRpcRequest({ method: 'ping', params: [] })).toBe(false);
    expect(isJsonRpcRequest({ id: {}, method: 'ping' })).toBe(false);
    expect(isJsonRpcRequest([])).toBe(false);
  });

  it('recognises commands, backends and history groupings', () => {
    expect([isCommand('call'), isCommand('constructor')]).toEqual([true, false]);
    expect([isBuiltinBackend('exec'), isBuiltinBackend('x402-signer-hsm')]).toEqual([true, false]);
    expect([isGroupKey('payTo'), isGroupKey('toString')]).toEqual([true, false]);
  });
});

describe('scripts/install-hooks.mjs', () => {
  const script = resolve('scripts/install-hooks.mjs');
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  it('points git at .githooks in the root of a checkout', () => {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, '.githooks'), { recursive: true });
    writeFileSync(join(repo, '.githooks', 'pre-commit'), '#!/bin/sh\n');
    git(repo, 'init', '-q');
    execFileSync(process.execPath, [script], { cwd: repo });
    expect(git(repo, 'config', '--local', 'core.hooksPath')).toBe('.githooks');
  });

  it('changes nothing in a directory nested inside another repository', () => {
    const outer = join(home, 'outer');
    const nested = join(outer, 'node_modules', 'pkg');
    mkdirSync(join(nested, '.githooks'), { recursive: true });
    writeFileSync(join(nested, '.githooks', 'pre-commit'), '#!/bin/sh\n');
    git(outer, 'init', '-q');
    execFileSync(process.execPath, [script], { cwd: nested });
    expect(() => git(outer, 'config', '--local', 'core.hooksPath')).toThrow();
  });
});
