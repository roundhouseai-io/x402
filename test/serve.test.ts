import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CONFIG, mergeDeep } from '../src/core/config.js';
import { Engine } from '../src/core/engine.js';
import { OwsClient } from '../src/core/ows.js';
import { ExitCode } from '../src/core/errors.js';
import { createServeServer, statusForCode, tightestMax } from '../src/serve/http.js';
import { dispatch, TOOLS } from '../src/serve/mcp.js';
import {
  createToken,
  verifyToken,
  revokeToken,
  loadTokens,
  tokenAllowsCapability,
} from '../src/serve/tokens.js';
import { paths } from '../src/core/paths.js';
import type { SignerBackend } from '../src/core/signer.js';

const PAY_TO = '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const requirements = (amountAtomic = '2000') => ({
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: amountAtomic,
      payTo: PAY_TO,
      asset: USDC,
      maxTimeoutSeconds: 120,
    },
  ],
});

class FakeSigner implements SignerBackend {
  readonly backend = 'fake';
  readonly wallet = 'test-wallet';
  count = 0;
  async capabilities() {
    return { typedData: true, policies: false, balances: false, accounts: true, declared: true };
  }
  async getAccounts() {
    return [{ id: this.wallet, address: await this.getAddress() }];
  }
  async getAddress() {
    return '0x000000000000000000000000000000000000dEaD';
  }
  async signTypedData() {
    this.count++;
    return `0x${'cd'.repeat(32)}`;
  }
}

let home: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-serve-'));
  process.env.X402_HOME = home;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.X402_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('caller tokens', () => {
  it('stores only a hash, 0600', () => {
    const { plaintext, token } = createToken({ name: 'agent-1', budgetDaily: '1.00' });
    expect(plaintext.startsWith('x402_')).toBe(true);
    expect(statSync(paths.tokens()).mode & 0o777).toBe(0o600);
    const stored = JSON.stringify(loadTokens());
    expect(stored).not.toContain(plaintext);
    expect(verifyToken(plaintext)?.name).toBe('agent-1');
    expect(token.budgetDaily).toBe('1.00');
  });

  it('rejects unknown and revoked tokens', () => {
    const { plaintext } = createToken({ name: 'agent-2' });
    expect(verifyToken('x402_nope')).toBeUndefined();
    expect(revokeToken('agent-2')).toBe(true);
    expect(verifyToken(plaintext)).toBeUndefined();
  });

  it('refuses duplicate live names', () => {
    createToken({ name: 'dup' });
    expect(() => createToken({ name: 'dup' })).toThrow(/already exists/);
  });

  it('scopes capabilities', () => {
    const { token } = createToken({ name: 'scoped', capabilities: ['lei'] });
    expect(tokenAllowsCapability(token, 'lei')).toBe(true);
    expect(tokenAllowsCapability(token, 'kyb')).toBe(false);
    expect(tokenAllowsCapability(token, undefined)).toBe(false);
    expect(tokenAllowsCapability({ ...token, capabilities: [] }, undefined)).toBe(true);
  });
});

describe('exit-code mapping', () => {
  it('maps codes to HTTP statuses', () => {
    expect(statusForCode(ExitCode.OK)).toBe(200);
    expect(statusForCode(ExitCode.POLICY_DENIED)).toBe(403);
    expect(statusForCode(ExitCode.OVER_MAX)).toBe(429);
    expect(statusForCode(ExitCode.INSUFFICIENT_BALANCE)).toBe(402);
    expect(statusForCode(ExitCode.OWS_UNREACHABLE)).toBe(503);
  });

  it('takes the stricter per-call cap', () => {
    expect(tightestMax('0.05', '0.01')).toBe('0.01');
    expect(tightestMax('0.005', '0.01')).toBe('0.005');
    expect(tightestMax(undefined, '0.01')).toBe('0.01');
    expect(tightestMax('0.02', undefined)).toBe('0.02');
  });
});

describe('serve HTTP API', () => {
  async function withServer(
    run: (base: string) => Promise<void>,
    configOverrides: Record<string, unknown> = {},
  ) {
    const config = mergeDeep(DEFAULT_CONFIG, configOverrides);
    const engine = new Engine({
      config,
      signer: async () => new FakeSigner(),
      walletName: 'test-wallet',
      backendName: 'fake',
    });
    const server = createServeServer({
      engine,
      config,
      ows: new OwsClient({ endpoint: 'http://127.0.0.1:1' }),
      host: '127.0.0.1',
      port: 0,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // The server calls the engine through global fetch, which is mocked; use a
  // real HTTP client for the server itself.
  async function post(
    base: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const { request: nodeRequest } = await import('node:http');
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = nodeRequest(
        `${base}${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }),
          );
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('rejects requests without a caller token', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/v1/call', { url: 'https://api.example.com' });
      expect(res.status).toBe(401);
      expect(res.json.ok).toBe(false);
    });
  });

  it('runs the payment loop for an authorized caller', async () => {
    const { plaintext } = createToken({ name: 'agent', maxPerCall: '0.01' });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(requirements()), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ lei: 'X' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await withServer(async (base) => {
      const res = await post(
        base,
        '/v1/call',
        {
          url: 'https://api.example.com/v1/lei',
          data: { query: 'Amplify Limited' },
          method: 'GET',
        },
        { authorization: `Bearer ${plaintext}` },
      );
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, paid: true, amount: '0.002', asset: 'usdc' });
      expect(res.json.receiptId).toBeTruthy();
    });
  });

  it('surfaces the CLI exit code as errorCode', async () => {
    const { plaintext } = createToken({ name: 'agent', maxPerCall: '0.0001' });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(requirements()), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await withServer(async (base) => {
      const res = await post(
        base,
        '/v1/call',
        { url: 'https://api.example.com/v1/lei' },
        { authorization: `Bearer ${plaintext}` },
      );
      expect(res.status).toBe(429);
      expect(res.json.errorCode).toBe(ExitCode.OVER_MAX);
      expect(res.json.errorName).toBe('over_max');
    });
  });

  it('denies a capability outside the token scope', async () => {
    const { plaintext } = createToken({ name: 'scoped', capabilities: ['kyb'] });
    await withServer(async (base) => {
      const res = await post(
        base,
        '/v1/call',
        { url: 'x402:lei' },
        { authorization: `Bearer ${plaintext}` },
      );
      expect(res.status).toBe(403);
      expect(res.json.errorCode).toBe(ExitCode.ALLOWLIST_DENIED);
    });
  });

  it('replays an Idempotency-Key without paying twice', async () => {
    const { plaintext } = createToken({ name: 'agent' });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(requirements()), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ lei: 'X' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await withServer(async (base) => {
      const headers = { authorization: `Bearer ${plaintext}`, 'idempotency-key': 'abc-123' };
      const first = await post(
        base,
        '/v1/call',
        { url: 'https://api.example.com/v1/lei' },
        headers,
      );
      expect(first.json.paid).toBe(true);
      const second = await post(
        base,
        '/v1/call',
        { url: 'https://api.example.com/v1/lei' },
        headers,
      );
      expect(second.json.replayed).toBe(true);
      // Payload level is `hash`, so the response body is not replayable.
      expect(second.json.bodyReplay).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe('MCP server', () => {
  const deps = () => ({
    engine: new Engine({
      config: DEFAULT_CONFIG,
      signer: async () => new FakeSigner(),
      walletName: 'test-wallet',
      backendName: 'fake',
    }),
    config: DEFAULT_CONFIG,
    version: '0.1.0',
  });

  it('advertises the four tools', async () => {
    const res = await dispatch(deps(), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((res as any).result.tools.map((t: { name: string }) => t.name)).toEqual([
      'x402_call',
      'x402_probe',
      'x402_discover',
      'x402_history',
    ]);
    expect(TOOLS).toHaveLength(4);
  });

  it('reports protocol and server info on initialize', async () => {
    const res = await dispatch(deps(), { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect((res as any).result.serverInfo.name).toBe('x402');
  });

  it('answers notifications with nothing', async () => {
    expect(
      await dispatch(deps(), { jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBeUndefined();
  });

  it('runs x402_call through the engine', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ lei: 'X' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = (await dispatch(deps(), {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'x402_call', arguments: { url: 'https://api.example.com/v1/lei' } },
    })) as any;
    const envelope = JSON.parse(res.result.content[0].text);
    expect(envelope).toMatchObject({ ok: true, paid: false });
  });

  it('reports unknown methods as JSON-RPC errors', async () => {
    const res = (await dispatch(deps(), { jsonrpc: '2.0', id: 3, method: 'nope' })) as any;
    expect(res.error.code).toBe(-32601);
  });
});
