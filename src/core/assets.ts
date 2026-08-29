/** Chain and asset tables. v1 is Base + USDC; the shape is ready for more. */

export interface ChainInfo {
  /** Canonical short name used in x402 payloads. */
  network: string;
  chainId: number;
  aliases: string[];
  /** Native currency symbol, for balance reporting. */
  nativeSymbol: string;
  /**
   * A public JSON-RPC endpoint, used only for reading balances.
   *
   * Override with `rpc.<network>`. Nothing in the payment path calls an RPC —
   * an x402 payment is a signed authorization the facilitator submits — so a
   * missing or rate-limited endpoint costs you `wallet balance`, nothing else.
   */
  rpcUrl: string;
}

export const CHAINS: ChainInfo[] = [
  {
    network: 'base',
    chainId: 8453,
    aliases: ['base', 'base-mainnet', 'eip155:8453', '8453'],
    nativeSymbol: 'ETH',
    rpcUrl: 'https://mainnet.base.org',
  },
  {
    network: 'ethereum',
    chainId: 1,
    aliases: ['ethereum', 'mainnet', 'eth', 'eip155:1', '1'],
    nativeSymbol: 'ETH',
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
  },
  {
    network: 'base-sepolia',
    chainId: 84532,
    aliases: ['base-sepolia', 'basesepolia', 'eip155:84532', '84532'],
    nativeSymbol: 'ETH',
    rpcUrl: 'https://sepolia.base.org',
  },
];

export function findChain(input: string | number | undefined): ChainInfo | undefined {
  if (input === undefined) return undefined;
  const needle = String(input).toLowerCase().trim();
  return CHAINS.find((c) => c.aliases.includes(needle));
}

export const caip2 = (chainId: number) => `eip155:${chainId}`;

export interface AssetInfo {
  symbol: string;
  address: string;
  decimals: number;
  chainId: number;
  /** EIP-712 domain fields for EIP-3009. */
  eip712: { name: string; version: string };
}

export const ASSETS: AssetInfo[] = [
  {
    symbol: 'usdc',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    chainId: 8453,
    eip712: { name: 'USD Coin', version: '2' },
  },
  {
    symbol: 'usdc',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    chainId: 1,
    // Read from the contract, not copied from a doc: name() "USD Coin",
    // version() "2", decimals() 6, and DOMAIN_SEPARATOR() present.
    eip712: { name: 'USD Coin', version: '2' },
  },
  {
    symbol: 'usdc',
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    decimals: 6,
    chainId: 84532,
    eip712: { name: 'USDC', version: '2' },
  },
];

export function findAsset(address: string | undefined, chainId?: number): AssetInfo | undefined {
  if (!address) return undefined;
  const needle = address.toLowerCase();
  return ASSETS.find(
    (a) =>
      (a.address.toLowerCase() === needle || a.symbol === needle) &&
      (chainId === undefined || a.chainId === chainId),
  );
}

/** Format an atomic amount as a decimal string, trimming trailing zeros. */
export function formatUnits(atomic: bigint, decimals: number): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Parse a decimal string into atomic units. Throws on more precision than the asset has. */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error(`not a decimal amount: ${value}`);
  }
  const negative = trimmed.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  if (frac.length > decimals) {
    throw new Error(`amount ${value} has more than ${decimals} decimal places`);
  }
  const atomic =
    BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return negative ? -atomic : atomic;
}
