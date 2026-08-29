import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readBalances } from '../src/core/rpc.js';
import { proxyHint } from '../src/core/http.js';
import { findChain, findAsset } from '../src/core/assets.js';
import { ExitCode, X402Error } from '../src/core/errors.js';

const ADDRESS = '0x2D43136FfBbbe0ED5CBaaB2E8B2b8c968059114C';

/** Hex-encode a uint256 the way an RPC returns one. */
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;

/**
 * A stubbed RPC. Records what was asked so the encoding can be checked — a
 * mis-encoded `balanceOf` returns someone else's balance rather than an error,
 * which is the kind of wrong that looks right.
 */
function stubRpc(handler: (method: string, params: unknown[]) => unknown): {
  calls: { method: string; params: unknown[] }[];
} {
  const calls: { method: string; params: unknown[] }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { method: string; params: unknown[] };
    calls.push({ method: req.method, params: req.params });
    const result = handler(req.method, req.params);
    return {
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    };
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading balances from the chain', () => {
  it('reports native and token balances, formatted by their own decimals', async () => {
    stubRpc((method) =>
      method === 'eth_getBalance' ? word(1_500_000_000_000_000n) : word(928_000n),
    );
    const out = await readBalances(ADDRESS, 'base');
    expect(out.chain).toBe('base');
    expect(out.chainId).toBe(8453);
    // 18 decimals for ETH, 6 for USDC — not one shared assumption.
    expect(out.native).toMatchObject({ symbol: 'ETH', amount: '0.0015', decimals: 18 });
    expect(out.tokens).toEqual([
      {
        symbol: 'usdc',
        amount: '0.928',
        atomic: '928000',
        decimals: 6,
        contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
    ]);
  });

  it('encodes balanceOf against the right contract, left-padded to 32 bytes', async () => {
    const { calls } = stubRpc((method) => (method === 'eth_getBalance' ? word(0n) : word(0n)));
    await readBalances(ADDRESS, 'base');
    const call = calls.find((c) => c.method === 'eth_call');
    expect(call).toBeDefined();
    const [tx] = (call?.params ?? []) as [{ to: string; data: string }];
    expect(tx.to).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    // selector + 24 zero nibbles of padding + the 40-nibble address
    expect(tx.data).toBe(`0x70a08231${'0'.repeat(24)}${ADDRESS.slice(2).toLowerCase()}`);
  });

  it('says a wallet can pay x402 on token balance alone, never on ETH', async () => {
    // The misreading this exists to prevent: an x402 payment is an EIP-3009
    // authorization the facilitator submits, so the payer needs USDC and no gas.
    stubRpc((method) => (method === 'eth_getBalance' ? word(0n) : word(928_000n)));
    const funded = await readBalances(ADDRESS, 'base');
    expect(funded.native.amount).toBe('0');
    expect(funded.canPayX402).toBe(true);

    stubRpc((method) => (method === 'eth_getBalance' ? word(10n ** 18n) : word(0n)));
    const gasOnly = await readBalances(ADDRESS, 'base');
    expect(gasOnly.native.amount).toBe('1');
    expect(gasOnly.canPayX402).toBe(false);
  });

  it('reads ethereum mainnet, with its own USDC contract', async () => {
    stubRpc(() => word(0n));
    const out = await readBalances(ADDRESS, 'ethereum');
    expect(out.chainId).toBe(1);
    expect(out.tokens[0]?.contract).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  });

  it('takes any spelling of a chain the rest of the CLI accepts', async () => {
    for (const spelling of ['ethereum', 'mainnet', 'eth', 'eip155:1', '1']) {
      stubRpc(() => word(0n));
      expect((await readBalances(ADDRESS, spelling)).chainId).toBe(1);
    }
  });

  it('honours an rpc override rather than the built-in public endpoint', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return { status: 200, headers: new Headers(), text: async () => '{"result":"0x0"}' };
    });
    await readBalances(ADDRESS, 'base', { rpc: { base: 'https://my-node.example.com' } });
    expect(seen.every((u) => u === 'https://my-node.example.com')).toBe(true);
  });

  it('reads several chains from one comma-separated value', async () => {
    // `--chain` is a single-value flag CLI-wide, so a repeated flag keeps only
    // the last one — and also overrides defaults.chain, which made a second
    // --chain look like it worked while silently dropping the first.
    const chains = 'base, ethereum'.split(',').map((c) => c.trim());
    const ids: number[] = [];
    for (const chain of chains) {
      stubRpc(() => word(0n));
      ids.push((await readBalances(ADDRESS, chain)).chainId);
    }
    expect(ids).toEqual([8453, 1]);
  });

  it('refuses an unknown chain and a non-address', async () => {
    await expect(readBalances(ADDRESS, 'solana')).rejects.toThrow(/unknown chain "solana"/);
    await expect(readBalances('not-an-address', 'base')).rejects.toThrow(/not an EVM address/);
  });

  it('surfaces an RPC error rather than reporting a zero balance', async () => {
    // Reporting 0 on a failed read would say "unfunded" about a funded wallet.
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
    }));
    try {
      await readBalances(ADDRESS, 'base');
      throw new Error('should have thrown');
    } catch (err) {
      // SAFETY: the line above proves this threw; the reads below fail the test
      // if it was not an X402Error, which is the assertion.
      expect((err as X402Error).code).toBe(ExitCode.GENERIC);
      expect((err as Error).message).toContain('rate limited');
    }
  });
});

describe('the chain table these balances come from', () => {
  it('carries the on-chain EIP-712 domain for each USDC, read from the contract', () => {
    // name() "USD Coin" and version() "2" were read from both contracts; a
    // wrong domain produces a signature no facilitator will settle.
    expect(findAsset('usdc', 1)?.eip712).toEqual({ name: 'USD Coin', version: '2' });
    expect(findAsset('usdc', 8453)?.eip712).toEqual({ name: 'USD Coin', version: '2' });
    expect(findAsset('usdc', 1)?.decimals).toBe(6);
  });

  it('gives every chain a native symbol and a default endpoint', () => {
    for (const name of ['base', 'ethereum', 'base-sepolia']) {
      const chain = findChain(name);
      expect(chain?.nativeSymbol).toBe('ETH');
      expect(chain?.rpcUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('a proxy Node is quietly ignoring', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
  });
  afterEach(() => {
    process.env = saved;
  });

  it('names the flag when a proxy is set and not enabled', () => {
    const hint = proxyHint({ HTTPS_PROXY: 'http://127.0.0.1:8080' });
    expect(hint).toContain('http://127.0.0.1:8080');
    expect(hint).toContain('--use-env-proxy');
  });

  it('says nothing when no proxy is configured', () => {
    expect(proxyHint({})).toBe('');
  });

  it('says nothing once the flag is already on', () => {
    expect(proxyHint({ HTTPS_PROXY: 'http://p', NODE_OPTIONS: '--use-env-proxy' })).toBe('');
    expect(proxyHint({ HTTPS_PROXY: 'http://p', NODE_USE_ENV_PROXY: '1' })).toBe('');
  });
});
