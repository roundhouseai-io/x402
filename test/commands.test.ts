/**
 * Every top-level command, driven through `main()` the way an agent drives the
 * binary: argv in, one JSON object on stdout, an exit code out.
 *
 * Hermetic by construction. `X402_HOME` is a fresh temp dir per test, `fetch`
 * is stubbed (an unstubbed call fails the test rather than reaching the
 * network), and signing goes through the `exec` backend pointed at a tiny Node
 * script that returns a fixed signature. No real key, wallet or payment exists
 * anywhere in this file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { ExitCode } from '../src/core/errors.js';
import { readRecords } from '../src/core/ledger.js';
import { decodePaymentHeader } from '../src/core/eip3009.js';
import { testUrlFor } from '../src/commands/setup.js';
import { VERSION } from '../src/version.js';
import type { JsonObject } from '../src/core/json.js';

const ADDRESS = '0x000000000000000000000000000000000000dEaD';
const PAY_TO = '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SIGNATURE = `0x${'ef'.repeat(65)}`;
const URL_PAID = 'https://api.example.com/v1/lei';

const quote = (amountAtomic = '2000') => ({
  x402Version: 1,
  error: 'payment required',
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: amountAtomic,
      resource: URL_PAID,
      payTo: PAY_TO,
      asset: USDC_BASE,
      maxTimeoutSeconds: 120,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
});

function jsonResponse<T>(status: number, body: T, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** Route `fetch` by URL. Anything unrouted throws, so nothing leaks to the network. */
function stubFetch(route: (url: string, headers: Record<string, string>) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: { headers?: Record<string, string> }) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v;
      seen.push({ url, headers });
      return route(url, headers);
    },
  );
  return seen;
}

let home: string;
let out: string[];
let err: string[];

/** Run the CLI and return the exit code plus stdout parsed as JSON when it is JSON. */
async function run(...argv: string[]): Promise<{ code: number; json: any; stdout: string }> {
  out = [];
  const code = await main(argv);
  const stdout = out.join('');
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { code, json, stdout };
}

function writeSigner(): string {
  const path = join(home, 'signer.mjs');
  writeFileSync(
    path,
    `import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const reply = (result) => process.stdout.write(JSON.stringify({ x402Signer: 1, id: input.id, result }) + '\\n');
if (input.method === 'capabilities') reply({ typedData: true, policies: false, accounts: true });
else if (input.method === 'getAddress') reply({ address: '${ADDRESS}' });
else if (input.method === 'getAccounts') reply({ accounts: [{ id: 'dev', address: '${ADDRESS}' }, { id: 'old', address: '${PAY_TO}' }] });
else if (input.method === 'signTypedData') reply({ signature: '${SIGNATURE}' });
else process.stdout.write(JSON.stringify({ error: { code: 'unsupported', message: input.method } }) + '\\n');
`,
    { mode: 0o700 },
  );
  return path;
}

function writeUserConfig(extra: JsonObject = {}): void {
  const config = {
    wallet: {
      backend: 'exec',
      default: 'dev',
      backends: { exec: { command: process.execPath, args: [writeSigner()], timeoutMs: 10_000 } },
    },
    ...extra,
  };
  writeFileSync(join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-cmd-'));
  process.env.X402_HOME = home;
  // Never wait on the test runner's stdin pipe.
  process.env.X402_STDIN_WAIT_MS = '1';
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  stubFetch((url) => {
    throw new Error(`unexpected network call in a unit test: ${url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.X402_HOME;
  delete process.env.X402_STDIN_WAIT_MS;
  rmSync(home, { recursive: true, force: true });
});

describe('help, version and the exit-code table', () => {
  it('prints the version for --version and `version`', async () => {
    expect((await run('--version')).stdout).toBe(`${VERSION}\n`);
    expect((await run('version')).stdout).toBe(`${VERSION}\n`);
  });

  it('prints help; bare invocation exits 1 so a script notices', async () => {
    const help = await run('--help');
    expect(help.code).toBe(ExitCode.OK);
    expect(help.stdout).toContain('usage');
    expect(help.stdout).not.toMatch(/^\s*x402 call/m);
    expect((await run()).code).toBe(ExitCode.GENERIC);
    expect((await run('help')).code).toBe(ExitCode.OK);
  });

  it('prints the exit-code table as JSON, markdown and text', async () => {
    const json = await run('help', 'exit-codes', '--json');
    expect(json.json.ok).toBe(true);
    expect(json.json.codes.map((c: { code: number }) => c.code)).toContain(ExitCode.OVER_MAX);
    expect((await run('help', 'exit-codes', '--markdown')).stdout).toContain('|');
    expect((await run('help', 'exit-codes')).stdout).toContain('44');
  });

  it('falls back to help for a word that is neither a command nor a URL', async () => {
    const res = await run('frobnicate');
    expect(res.stdout).toContain('usage');
  });

  it('reports a bad flag value as a JSON error, not a stack trace', async () => {
    const res = await run('call', URL_PAID, '--telemetry-payload', 'everything');
    expect(res.code).toBe(ExitCode.GENERIC);
    expect(res.json).toMatchObject({ ok: false, errorCode: 1, errorName: expect.any(String) });
    expect(res.json.error).toContain('--telemetry-payload');
  });
});

describe('call', () => {
  it('pays a 402, retries with the payment header, and records the receipt', async () => {
    writeUserConfig();
    const seen = stubFetch((url, headers) => {
      expect(url).toBe(URL_PAID);
      return headers['x-payment']
        ? jsonResponse(200, { lei: '213800ABCDEF' })
        : jsonResponse(402, quote());
    });

    const receiptOut = join(home, 'receipt.json');
    const res = await run('call', URL_PAID, '--max', '0.01', '--receipt-out', receiptOut);

    expect(res.code).toBe(ExitCode.OK);
    expect(res.json).toMatchObject({ ok: true, status: 200, paid: true, amount: '0.002' });
    expect(res.json.body).toEqual({ lei: '213800ABCDEF' });
    expect(seen).toHaveLength(2);
    const payment = decodePaymentHeader(seen[1]!.headers['x-payment']!) as {
      payload: { signature: string; authorization: { to: string; value: string } };
    };
    expect(payment.payload.signature).toBe(SIGNATURE);
    expect(payment.payload.authorization).toMatchObject({ value: '2000' });
    expect(payment.payload.authorization.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(existsSync(receiptOut)).toBe(true);
    expect(readRecords()).toHaveLength(1);
  });

  it('refuses a quote over --max without signing (exit 44)', async () => {
    writeUserConfig();
    const seen = stubFetch(() => jsonResponse(402, quote('50000')));
    const res = await run('call', URL_PAID, '--max', '0.01');
    expect(res.code).toBe(ExitCode.OVER_MAX);
    expect(res.json).toMatchObject({ ok: false, paid: false });
    // The 402 was read once; no paid retry was ever sent.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers['x-payment']).toBeUndefined();
  });

  it('shows what would be paid on --dry-run and sends nothing paid', async () => {
    writeUserConfig();
    const seen = stubFetch(() => jsonResponse(402, quote()));
    const res = await run('call', URL_PAID, '--max', '0.01', '--dry-run');
    expect(res.json).toMatchObject({ paid: false, dryRun: true });
    expect(seen.every((s) => s.headers['x-payment'] === undefined)).toBe(true);
  });

  it('treats a URL with no subcommand as `call`', async () => {
    writeUserConfig();
    stubFetch(() => jsonResponse(200, { free: true }));
    const res = await run(URL_PAID);
    expect(res.code).toBe(ExitCode.OK);
    expect(res.json).toMatchObject({ ok: true, paid: false, body: { free: true } });
  });

  it('calls the resource named in a saved quote, against a fresh 402', async () => {
    writeUserConfig();
    const file = join(home, '402.json');
    writeFileSync(file, JSON.stringify(quote()));
    const seen = stubFetch((_url, headers) =>
      headers['x-payment'] ? jsonResponse(200, { ok: 1 }) : jsonResponse(402, quote()),
    );
    const res = await run('call', `@${file}`, '--max', '0.01');
    expect(res.code).toBe(ExitCode.OK);
    expect(seen[0]!.url).toBe(URL_PAID);
  });

  it('needs a target', async () => {
    expect((await run('call')).code).toBe(ExitCode.GENERIC);
  });
});

describe('probe', () => {
  it('reports the price and never pays', async () => {
    writeUserConfig();
    const seen = stubFetch(() => jsonResponse(402, quote()));
    const res = await run('probe', URL_PAID);
    expect(res.code).toBe(ExitCode.OK);
    expect(res.json).toMatchObject({
      ok: true,
      paymentRequired: true,
      selected: { amount: '0.002', amountAtomic: '2000', payTo: PAY_TO, network: 'base' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers['x-payment']).toBeUndefined();
  });

  it('says plainly when no payment is required', async () => {
    stubFetch(() => jsonResponse(200, { hello: 'world' }));
    const res = await run('probe', URL_PAID);
    expect(res.json).toMatchObject({
      paymentRequired: false,
      status: 200,
      body: { hello: 'world' },
    });
  });

  it('needs a target', async () => {
    expect((await run('probe')).code).toBe(ExitCode.GENERIC);
  });
});

describe('pay', () => {
  it('signs a 402 payload into an X-PAYMENT header with no HTTP at all', async () => {
    writeUserConfig();
    const res = await run('pay', JSON.stringify(quote()), '--max', '0.01');
    expect(res.code).toBe(ExitCode.OK);
    expect(res.json.ok).toBe(true);
    expect(res.json.headerName ?? res.json.header?.name ?? 'X-PAYMENT').toMatch(/X-PAYMENT/i);
    expect(JSON.stringify(res.json)).toContain(PAY_TO);
  });

  it('reads a quote from @file', async () => {
    writeUserConfig();
    const file = join(home, 'q.json');
    writeFileSync(file, JSON.stringify(quote()));
    expect((await run('pay', `@${file}`, '--max', '0.01')).code).toBe(ExitCode.OK);
  });

  it('refuses a quote over --max before signing (exit 44)', async () => {
    writeUserConfig();
    const res = await run('pay', JSON.stringify(quote('90000')), '--max', '0.01');
    expect(res.code).toBe(ExitCode.OVER_MAX);
  });

  it('refuses a recipient outside the allowlist (exit 43)', async () => {
    writeUserConfig({ allowlist: { payTo: [ADDRESS], domains: [] } });
    const res = await run('pay', JSON.stringify(quote()), '--max', '0.01');
    expect(res.code).toBe(ExitCode.ALLOWLIST_DENIED);
  });
});

describe('verify', () => {
  it('reports a recorded settlement as untrusted when no facilitator is configured', async () => {
    const receipt = {
      id: 'r1',
      amount: '0.002',
      settlement: { success: true, transaction: '0xabc' },
    };
    const res = await run('verify', JSON.stringify(receipt));
    expect(res.code).toBe(ExitCode.OK);
    expect(res.json).toMatchObject({ verified: true, source: 'receipt', trusted: false });
  });

  it('asks the configured facilitator, with its token, and trusts its answer', async () => {
    writeUserConfig({
      facilitator: { url: 'https://facilitator.example/', token: 'env:TEST_FACILITATOR_TOKEN' },
    });
    process.env.TEST_FACILITATOR_TOKEN = 'test-token';
    const seen = stubFetch(() =>
      jsonResponse(200, { success: true, transaction: '0xabc', network: 'base' }),
    );
    try {
      const receipt = { id: 'r1', settlement: { success: true, transaction: '0xabc' } };
      const res = await run('verify', JSON.stringify(receipt));
      expect(res.json).toMatchObject({ verified: true, source: 'facilitator', trusted: true });
      expect(seen[0]!.url).toBe('https://facilitator.example/settlement/0xabc');
      expect(seen[0]!.headers.authorization).toBe('Bearer test-token');
    } finally {
      delete process.env.TEST_FACILITATOR_TOKEN;
    }
  });

  it('does not treat a facilitator body without a transaction as settled', async () => {
    writeUserConfig({ facilitator: { url: 'https://facilitator.example/' } });
    stubFetch(() => jsonResponse(200, { success: true }));
    const receipt = { id: 'r1', settlement: { success: true, transaction: '0xabc' } };
    const res = await run('verify', JSON.stringify(receipt));
    expect(res.code).toBe(ExitCode.GENERIC);
    expect(res.json).toMatchObject({ verified: false, source: 'facilitator', trusted: true });
  });

  it('does not treat success: false as settled', async () => {
    writeUserConfig({ facilitator: { url: 'https://facilitator.example/' } });
    stubFetch(() => jsonResponse(200, { success: false, transaction: '0xabc' }));
    const receipt = { id: 'r1', settlement: { success: true, transaction: '0xabc' } };
    const res = await run('verify', JSON.stringify(receipt));
    expect(res.json.verified).toBe(false);
    expect(res.code).toBe(ExitCode.GENERIC);
  });

  it('exits 1 with no settlement information', async () => {
    const res = await run('verify', JSON.stringify({ id: 'r2' }));
    expect(res.code).toBe(ExitCode.GENERIC);
    expect(res.json.source).toBe('none');
  });

  it('looks a receipt id up in the ledger', async () => {
    writeUserConfig();
    stubFetch((_url, headers) =>
      headers['x-payment']
        ? jsonResponse(
            200,
            { ok: 1 },
            {
              'x-payment-response': Buffer.from(
                JSON.stringify({ success: true, transaction: '0xfeed', network: 'base' }),
              ).toString('base64'),
            },
          )
        : jsonResponse(402, quote()),
    );
    const paid = await run('call', URL_PAID, '--max', '0.01');
    const res = await run('verify', paid.json.receiptId);
    expect(res.json.receiptId).toBe(paid.json.receiptId);
    expect(res.json.source).toBe('receipt');
  });

  it('names an unknown receipt id', async () => {
    const res = await run('verify', 'NOPE');
    expect(res.code).toBe(ExitCode.GENERIC);
    expect(res.json.error).toContain('NOPE');
  });
});

describe('history', () => {
  beforeEach(async () => {
    writeUserConfig();
    stubFetch((url, headers) => {
      if (url.endsWith('/free')) return jsonResponse(200, {});
      return headers['x-payment'] ? jsonResponse(200, {}) : jsonResponse(402, quote());
    });
    await run('call', URL_PAID, '--max', '0.01');
    await run('call', 'https://api.example.com/free');
  });

  it('lists ledger records', async () => {
    const res = await run('history');
    expect(res.json).toMatchObject({ ok: true, count: 2 });
  });

  it('filters to paid calls and by URL substring', async () => {
    expect((await run('history', '--paid-only')).json.count).toBe(1);
    expect((await run('history', 'free')).json.count).toBe(1);
  });

  it('sums spend, optionally grouped', async () => {
    const sum = await run('history', '--sum');
    const usdc = sum.json.rows.find((r: { asset: string }) => r.asset === 'usdc');
    expect(usdc).toMatchObject({ total: '0.002', paidCalls: 1, calls: 1 });
    const grouped = await run('history', '--by', 'payTo');
    expect(grouped.json.groupedBy).toBe('payTo');
  });

  it('rejects an unknown --by', async () => {
    expect((await run('history', '--by', 'colour')).code).toBe(ExitCode.GENERIC);
  });
});

describe('discover', () => {
  const endpoint = {
    resource: 'https://provider.example/v1/search',
    service_name: 'search',
    network: 'eip155:8453',
    pay_to: PAY_TO,
    asset: USDC_BASE,
    scheme: 'exact',
    price_usdc: '0.01',
    l30_total_calls: 10,
    l30_unique_payers: 3,
    is_live: true,
  };

  it('queries the default public index and lists providers', async () => {
    const seen = stubFetch((url) =>
      url.includes('/endpoints?')
        ? jsonResponse(200, { endpoints: [endpoint] })
        : jsonResponse(404, 'unknown capability'),
    );
    const res = await run('discover', 'web-search');
    expect(res.code).toBe(ExitCode.OK);
    expect(res.json).toMatchObject({ ok: true, capability: 'web-search', count: 1 });
    expect(seen[0]!.url.startsWith('https://api.roundhouseai.io/v0/unified')).toBe(true);
  });

  it('honours X402_INDEX_URL / X402_UNIFIED_URL for a self-hosted index', async () => {
    process.env.X402_INDEX_URL = 'https://index.example/v0';
    process.env.X402_UNIFIED_URL = 'https://index.example/v0/unified';
    try {
      const seen = stubFetch((url) =>
        url.includes('/endpoints?')
          ? jsonResponse(200, { endpoints: [endpoint] })
          : jsonResponse(404, 'unknown'),
      );
      await run('discover', 'web-search');
      expect(seen.map((s) => new URL(s.url).host)).toEqual(['index.example', 'index.example']);
    } finally {
      delete process.env.X402_INDEX_URL;
      delete process.env.X402_UNIFIED_URL;
    }
  });

  it('rejects a bad --spot-factor and a missing capability', async () => {
    expect((await run('discover')).code).toBe(ExitCode.GENERIC);
    stubFetch(() => jsonResponse(200, { endpoints: [endpoint] }));
    expect((await run('discover', 'x', '--spot-factor', '-1')).code).toBe(ExitCode.GENERIC);
  });
});

describe('serve', () => {
  it('creates, lists and revokes caller tokens; only a hash is stored', async () => {
    const created = await run('serve', 'token', 'create', 'bot', '--budget-daily', '1.00');
    expect(created.code).toBe(ExitCode.OK);
    const plaintext: string = created.json.token;
    expect(plaintext.length).toBeGreaterThan(16);
    expect(readFileSync(join(home, 'tokens.json'), 'utf8')).not.toContain(plaintext);

    const listed = await run('serve', 'token', 'list');
    expect(listed.json.tokens).toHaveLength(1);
    expect(JSON.stringify(listed.json)).not.toContain(plaintext);

    expect((await run('serve', 'token', 'revoke', 'bot')).code).toBe(ExitCode.OK);
    expect((await run('serve', 'token', 'revoke', 'bot')).code).toBe(ExitCode.GENERIC);
  });

  it('refuses a non-loopback bind without the explicit acknowledgement', async () => {
    const res = await run('serve', '--host', '0.0.0.0');
    expect(res.code).toBe(ExitCode.GENERIC);
    expect(res.json.error).toContain('exposes wallet spending');
  });

  it('validates token subcommands', async () => {
    expect((await run('serve', 'token', 'create')).code).toBe(ExitCode.GENERIC);
    expect((await run('serve', 'token', 'bogus')).code).toBe(ExitCode.GENERIC);
  });
});

describe('signer', () => {
  it('lists the built-in backends and marks the active one', async () => {
    writeUserConfig();
    const res = await run('signer', 'list');
    expect(res.json.active).toBe('exec');
    expect(res.json.backends.map((b: { backend: string }) => b.backend)).toEqual(
      expect.arrayContaining(['ows', 'ows-core', 'local', 'exec']),
    );
  });

  it('checks capabilities and the address', async () => {
    writeUserConfig();
    const res = await run('signer', 'check');
    expect(res.code).toBe(ExitCode.OK);
    expect(res.json).toMatchObject({
      ok: true,
      address: ADDRESS,
      capabilities: { typedData: true },
    });
  });

  it('lists an empty development keystore', async () => {
    const res = await run('signer', 'keystore', 'list');
    expect(res.json).toMatchObject({ ok: true, entries: [] });
  });

  it('refuses keystore add without a key file, and an unknown subcommand', async () => {
    expect((await run('signer', 'keystore', 'add', 'dev')).code).toBe(ExitCode.GENERIC);
    expect((await run('signer', 'nope')).code).toBe(ExitCode.GENERIC);
  });
});

describe('wallet', () => {
  it('prints the address from the signer backend', async () => {
    writeUserConfig();
    const res = await run('wallet', 'address');
    expect(res.json).toMatchObject({ ok: true, backend: 'exec', address: ADDRESS });
  });

  it('lists wallets, and forget hides one without deleting it', async () => {
    writeUserConfig();
    expect((await run('wallet', 'list')).json.wallets).toHaveLength(2);
    expect((await run('wallet', 'forget', 'old')).code).toBe(ExitCode.OK);
    const after = await run('wallet', 'list');
    expect(after.json.wallets.map((w: { id: string }) => w.id)).toEqual(['dev']);
    expect(after.json.hidden).toEqual(['old']);
    expect((await run('wallet', 'restore', 'old')).code).toBe(ExitCode.OK);
    expect((await run('wallet', 'list')).json.wallets).toHaveLength(2);
  });

  it('reads a balance from the configured RPC for an explicit --address', async () => {
    writeUserConfig({ rpc: { base: 'https://rpc.example' } });
    const seen = stubFetch(() =>
      // 1 USDC (6 decimals) for balanceOf, 0 for the native balance.
      jsonResponse(200, {
        jsonrpc: '2.0',
        id: 1,
        result: '0x00000000000000000000000000000000000000000000000000000000000f4240',
      }),
    );
    const res = await run('wallet', 'balance', '--address', ADDRESS);
    expect(seen.every((s) => s.url === 'https://rpc.example')).toBe(true);
    expect(res.json.ok).toBe(true);
    expect(res.json.address).toBe(ADDRESS);
  });

  it('rejects an unknown subcommand', async () => {
    writeUserConfig();
    expect((await run('wallet', 'teleport')).code).toBe(ExitCode.GENERIC);
  });
});

describe('config', () => {
  it('sets, gets, lists and unsets a value', async () => {
    expect((await run('config', 'set', 'limits.maxPerCall', '0.05')).code).toBe(ExitCode.OK);
    expect((await run('config', 'get', 'limits.maxPerCall')).json.value).toBe('0.05');
    const listed = await run('config', 'list');
    expect(listed.json.origins['limits.maxPerCall']).toBe('user');
    expect((await run('config', 'unset', 'limits.maxPerCall')).json.removed).toBe(true);
    expect((await run('config', 'get', 'limits.maxPerCall')).code).toBe(ExitCode.GENERIC);
  });

  it('never echoes a literal API key', async () => {
    const res = await run('config', 'set', 'auth.apiKey', 'rh_live_fixture_not_a_real_key');
    expect(res.stdout).not.toContain('rh_live_fixture_not_a_real_key');
  });

  it('reports an endpoint env override as its own origin', async () => {
    process.env.X402_TELEMETRY_URL = 'https://ingest.example/v0/telemetry';
    try {
      const listed = await run('config', 'list');
      expect(listed.json.config.telemetry.sink.url).toBe('https://ingest.example/v0/telemetry');
      expect(listed.json.origins['telemetry.sink.url']).toBe('env');
    } finally {
      delete process.env.X402_TELEMETRY_URL;
    }
  });

  it('refuses an unknown key', async () => {
    expect((await run('config', 'set', 'signer.backend', 'ows')).code).toBe(ExitCode.GENERIC);
  });
});

describe('skill and status', () => {
  it('prints SKILL.md', async () => {
    const res = await run('skill');
    expect(res.code).toBe(ExitCode.OK);
    expect(res.stdout).toContain('rh-x402');
  });
});

describe('setup', () => {
  it('rejects a malformed --min-balance before doing anything', async () => {
    const res = await run('setup', '--min-balance', 'lots');
    expect(res.code).toBe(ExitCode.GENERIC);
    expect(res.json.error).toContain('--min-balance');
  });

  it('derives the proving endpoint from the index URL', () => {
    expect(testUrlFor('https://api.roundhouseai.io/v0/')).toBe(
      'https://api.roundhouseai.io/v0/test/x402',
    );
  });
});

// `err` is captured so warnings never pollute the test output; referenced here
// so the capture is not dead code.
it('keeps stderr captured', () => {
  expect(Array.isArray(err)).toBe(true);
});
