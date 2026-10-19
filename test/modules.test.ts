/**
 * The modules the command tests reach only indirectly: the OWS HTTP client,
 * the bare HTTP wrapper, and the output emitter. `fetch` is stubbed; the OWS
 * "service" here is a function, never a running daemon.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwsClient, OwsSigner, noDaemonHint } from '../src/core/ows.js';
import { request, parseJsonBody, isJsonResponse, proxyHint } from '../src/core/http.js';
import { emitCallResult, toEnvelope } from '../src/core/output.js';
import { ExitCode, X402Error } from '../src/core/errors.js';
import type { CallResult } from '../src/core/engine.js';

const ADDRESS = '0x2D43136FfBbbe0ED5CBaaB2E8B2b8c968059114C';

function jsonResponse<T>(status: number, body: T) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'X-Mixed-Case': 'yes' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function expectCode(promise: Promise<unknown>, code: number): Promise<X402Error> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(X402Error);
    expect((err as X402Error).code).toBe(code);
    return err as X402Error;
  }
  throw new Error('expected a rejection');
}

describe('OwsClient', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (path === '/v1/wallets')
        return jsonResponse(200, {
          wallets: [{ id: 'w1', name: 'dev', address: ADDRESS, chains: ['base'] }],
        });
      if (path === '/v1/wallets/dev') return jsonResponse(200, { id: 'w1', address: ADDRESS });
      if (path === '/v1/wallets/dev/balance')
        return jsonResponse(200, { balance: '1.5', decimals: 6 });
      if (path === '/v1/wallets/dev/sign-typed-data')
        return jsonResponse(200, { signature: '0xabcd' });
      if (path === '/v1/wallets/nosig/sign-typed-data')
        return jsonResponse(200, { signature: 'nope' });
      if (path === '/v1/capabilities')
        return jsonResponse(200, { methods: ['signTypedData'], policies: [] });
      return jsonResponse(404, { error: 'not found' });
    });
  });

  const client = () => new OwsClient({ endpoint: 'http://127.0.0.1:8402/', apiKey: 'test-key' });

  it('lists wallets and sends the bearer token', async () => {
    const wallets = await client().listWallets();
    expect(wallets).toEqual([{ id: 'w1', name: 'dev', address: ADDRESS, chains: ['base'] }]);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer test-key',
    );
    expect(calls[0]!.url).toBe('http://127.0.0.1:8402/v1/wallets');
  });

  it('reads one wallet, a balance and capabilities', async () => {
    expect((await client().getWallet('dev')).address).toBe(ADDRESS);
    expect(await client().balance('dev', 'usdc', 'base')).toMatchObject({
      amount: '1.5',
      decimals: 6,
    });
    expect(await client().capabilities()).toEqual({ typedData: true, policies: true });
  });

  it('signs typed data and refuses a malformed signature (exit 47)', async () => {
    const td = { domain: {}, types: {}, primaryType: 'X', message: {} } as never;
    expect(await client().signTypedData('dev', td)).toBe('0xabcd');
    await expectCode(client().signTypedData('nosig', td), ExitCode.OWS_UNREACHABLE);
  });

  it('maps an HTTP error and an unreachable service onto exit codes', async () => {
    await expect(client().getWallet('missing')).rejects.toBeInstanceOf(X402Error);
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    const err = await expectCode(client().listWallets(), ExitCode.OWS_UNREACHABLE);
    expect(err.message).toContain('OWS unreachable');
    expect((await client().health()).ok).toBe(false);
    expect(await client().capabilities()).toBeUndefined();
  });

  it('wraps the client as a signer backend', async () => {
    const signer = new OwsSigner(client(), 'dev');
    expect(await signer.getAddress()).toBe(ADDRESS);
    expect(await signer.getAccounts()).toEqual([{ id: 'dev', address: ADDRESS, chains: ['base'] }]);
    expect((await signer.capabilities()).declared).toBe(true);
    expect(await signer.getBalance('usdc', 'base')).toMatchObject({ amount: '1.5' });
  });

  it('points a loopback endpoint at the in-process backend in its hint', () => {
    expect(noDaemonHint('http://127.0.0.1:8402')).not.toBe('');
  });
});

describe('request', () => {
  it('lower-cases response headers and reports size', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(200, { a: 1 }));
    const res = await request({
      url: 'https://x.example/',
      method: 'GET',
      headers: {},
      timeoutMs: 1000,
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-mixed-case']).toBe('yes');
    expect(res.bytes).toBe(7);
    expect(isJsonResponse(res.headers)).toBe(true);
  });

  it('turns an abort into a transient timeout error', async () => {
    vi.stubGlobal(
      'fetch',
      async (_u: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const err = await expectCode(
      request({ url: 'https://x.example/', method: 'GET', headers: {}, timeoutMs: 5 }),
      ExitCode.GENERIC,
    );
    expect(err.message).toContain('timed out');
  });

  it('turns a network failure into a transient network error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const err = await expectCode(
      request({ url: 'https://x.example/', method: 'GET', headers: {}, timeoutMs: 1000 }),
      ExitCode.GENERIC,
    );
    expect(err.message).toContain('network error');
  });

  it('parses JSON bodies leniently and gives no proxy hint without a proxy', () => {
    expect(parseJsonBody('')).toBeUndefined();
    expect(parseJsonBody('not json')).toBeUndefined();
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
    expect(proxyHint(false, {})).toBe('');
    expect(proxyHint(true, { HTTPS_PROXY: 'http://proxy.example:3128' })).toContain(
      'proxy.example',
    );
  });
});

describe('emitCallResult', () => {
  let out: string[];
  let dir: string;
  beforeEach(() => {
    out = [];
    dir = mkdtempSync(join(tmpdir(), 'x402-out-'));
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const result = (over: Partial<CallResult> = {}): CallResult =>
    ({
      ok: true,
      status: 200,
      paid: true,
      paymentState: 'settled',
      amount: '0.002',
      asset: 'usdc',
      receiptId: 'R1',
      url: 'https://api.example.com/x',
      body: { a: 1 },
      ...over,
    }) as CallResult;

  it('prints the bare body with --raw', () => {
    emitCallResult(result(), { raw: true, tty: false });
    expect(JSON.parse(out.join(''))).toEqual({ a: 1 });
  });

  it('writes the body to --out and leaves it out of the envelope', () => {
    const file = join(dir, 'body.json');
    emitCallResult(result(), { out: file, tty: false });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(JSON.parse(out.join('')).body).toBeUndefined();
  });

  it('prints a human summary with the receipt on a terminal', () => {
    emitCallResult(result(), { tty: true });
    const text = out.join('');
    expect(text).toContain('paid 0.002 usdc (settled)');
    expect(text).toContain('receipt R1');
  });

  it('names the error in the envelope', () => {
    const env = toEnvelope(result({ ok: false, paid: false, errorCode: 44, error: 'over max' }));
    expect(env).toMatchObject({ ok: false, errorCode: 44, errorName: expect.any(String) });
  });
});
