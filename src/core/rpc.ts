import { X402Error, ExitCode } from './errors.js';
import { request, proxyHint } from './http.js';
import { bypassesProxy, proxyFromEnv } from './proxy.js';
import {
  ASSETS,
  CHAINS,
  findChain,
  formatUnits,
  type AssetInfo,
  type ChainInfo,
} from './assets.js';

/**
 * The smallest JSON-RPC client that can answer "can this wallet pay?".
 *
 * Reading a balance is the one thing this CLI cannot ask a signer backend for
 * in general: `@open-wallet-standard/core` exports no balance function, and the
 * `local` keystore has nothing to ask. Going to the chain instead makes the
 * answer the same for every backend, which is what "is my wallet funded" should
 * have meant all along.
 *
 * Nothing in the payment path calls any of this. An x402 payment is a signed
 * EIP-3009 authorization that the facilitator submits, so a rate-limited or
 * unreachable RPC costs you `wallet balance` and nothing else.
 */

/** `balanceOf(address)` */
const BALANCE_OF = '0x70a08231';

interface RpcResponse {
  result?: string;
  error?: { code?: number; message?: string };
}

export function rpcUrlFor(chain: ChainInfo, overrides: Record<string, string>): string {
  return overrides[chain.network] ?? chain.rpcUrl;
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<string> {
  let res;
  try {
    res = await request({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      timeoutMs: 15_000,
    });
  } catch (err) {
    // SAFETY: `.message` off a non-Error is `undefined`, not a throw.
    throw new X402Error(
      ExitCode.GENERIC,
      `RPC ${url} unreachable: ${(err as Error).message}. Set a different endpoint with ` +
        '`rh-x402 config set rpc.<chain> <url>`.',
    );
  }
  let body: RpcResponse;
  try {
    body = JSON.parse(res.body) as RpcResponse;
  } catch {
    throw new X402Error(
      ExitCode.GENERIC,
      `RPC ${url} returned ${res.status}, not JSON.${proxyHint(usedProxy(url))}`,
    );
  }
  if (body.error) {
    throw new X402Error(
      ExitCode.GENERIC,
      `RPC ${url} refused ${method}: ${body.error.message ?? 'unknown error'}. ` +
        'Public endpoints rate-limit; set your own with `rh-x402 config set rpc.<chain> <url>`.',
    );
  }
  if (typeof body.result !== 'string') {
    throw new X402Error(ExitCode.GENERIC, `RPC ${url} returned no result for ${method}`);
  }
  return body.result;
}

/** Hex quantity → bigint. An empty result means the call reverted or hit nothing. */
function toBigInt(hex: string, what: string): bigint {
  if (!/^0x[0-9a-fA-F]*$/.test(hex) || hex === '0x') {
    throw new X402Error(ExitCode.GENERIC, `RPC returned ${hex || '(empty)'} for ${what}`);
  }
  return BigInt(hex);
}

export interface Balance {
  symbol: string;
  /** Decimal string, e.g. "0.978". */
  amount: string;
  atomic: string;
  decimals: number;
  /** Absent for the native currency, which has no contract. */
  contract?: string;
}

export interface WalletBalances {
  address: string;
  chain: string;
  chainId: number;
  rpcUrl: string;
  native: Balance;
  tokens: Balance[];
  /**
   * Whether this wallet can make an x402 payment on this chain.
   *
   * Deliberately *not* a function of the ETH balance. An x402 payment is an
   * EIP-3009 authorization; the facilitator submits it and pays the gas, so the
   * payer needs the token and no native currency at all. Conflating the two is
   * how "insufficient funds for gas" gets read as "x402 needs ETH".
   */
  canPayX402: boolean;
}

export interface BalanceOptions {
  /** `rpc.<network>` overrides from config. */
  rpc?: Record<string, string>;
  /** Restrict to one asset symbol; default is every known asset on the chain. */
  symbol?: string;
}

export async function readBalances(
  address: string,
  chainName: string,
  opts: BalanceOptions = {},
): Promise<WalletBalances> {
  const chain = findChain(chainName);
  if (!chain) {
    throw new X402Error(
      ExitCode.GENERIC,
      `unknown chain "${chainName}": known chains are ${CHAINS.map((c) => c.network).join(', ')}`,
    );
  }
  if (chain.family === 'svm') {
    throw new X402Error(
      ExitCode.GENERIC,
      `balance reads are EVM-only for now: ${chain.network} is not supported by \`wallet balance\``,
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new X402Error(ExitCode.GENERIC, `not an EVM address: ${address}`);
  }

  const url = rpcUrlFor(chain, opts.rpc ?? {});
  const nativeHex = await rpcCall(url, 'eth_getBalance', [address, 'latest']);
  const nativeAtomic = toBigInt(nativeHex, 'eth_getBalance');

  const assets = ASSETS.filter(
    (a) => a.caip2 === chain.caip2 && (!opts.symbol || a.symbol === opts.symbol),
  );
  const tokens: Balance[] = [];
  for (const asset of assets) {
    tokens.push(await readToken(url, address, asset));
  }

  return {
    address,
    chain: chain.network,
    chainId: chain.chainId,
    rpcUrl: url,
    native: {
      symbol: chain.nativeSymbol,
      amount: formatUnits(nativeAtomic, 18),
      atomic: nativeAtomic.toString(),
      decimals: 18,
    },
    tokens,
    canPayX402: tokens.some((t) => BigInt(t.atomic) > 0n),
  };
}

async function readToken(url: string, address: string, asset: AssetInfo): Promise<Balance> {
  const data = `${BALANCE_OF}${address.slice(2).toLowerCase().padStart(64, '0')}`;
  const hex = await rpcCall(url, 'eth_call', [{ to: asset.address, data }, 'latest']);
  const atomic = toBigInt(hex, `balanceOf on ${asset.address}`);
  return {
    symbol: asset.symbol,
    amount: formatUnits(atomic, asset.decimals),
    atomic: atomic.toString(),
    decimals: asset.decimals,
    contract: asset.address,
  };
}

/** Whether a request to `url` would have gone through the proxy. */
function usedProxy(url: string): boolean {
  const proxy = proxyFromEnv();
  if (!proxy) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return !bypassesProxy(parsed.hostname, Number(parsed.port || 443), proxy.noProxy);
  } catch {
    return false;
  }
}
