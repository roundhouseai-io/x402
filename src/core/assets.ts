/** Chain and asset tables. v1 is Base + USDC; the shape is ready for more. */

/** The signature scheme a chain settles with: EIP-3009 on EVM, a partly signed transaction on SVM. */
export type ChainFamily = 'evm' | 'svm';

export interface ChainInfo {
  /** Canonical short name used in x402 payloads. */
  network: string;
  family: ChainFamily;
  /** CAIP-2 identifier, the one key that is unique across families. */
  caip2: string;
  /**
   * The EVM chain id. Zero on a chain that has none; compare `caip2` instead of
   * this whenever the family is not known to be EVM.
   */
  chainId: number;
  aliases: string[];
  /** Native currency symbol, for balance reporting. */
  nativeSymbol: string;
  /**
   * Whether an x402 payment may be settled on this chain.
   *
   * A chain can be readable without being payable. Ethereum mainnet is here so
   * `wallet balance` can see funds held there, but x402 does not need it — Base
   * is where the payments happen, and settling on mainnet would cost a
   * multiple of the payment in gas for no benefit. A 402 quoting a chain with
   * this false is refused, with the reason said out loud.
   */
  x402: boolean;
  /**
   * A public JSON-RPC endpoint, used only for reading balances.
   *
   * Override with `rpc.<network>`. Nothing in the payment path calls an RPC —
   * an x402 payment is a signed authorization the facilitator submits — so a
   * missing or rate-limited endpoint costs you `wallet balance`, nothing else.
   */
  rpcUrl: string;
}

/** CAIP-2 for Solana: the first 32 characters of the genesis block hash. */
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

export const CHAINS: ChainInfo[] = [
  {
    network: 'base',
    family: 'evm',
    caip2: 'eip155:8453',
    chainId: 8453,
    aliases: ['base', 'base-mainnet', 'eip155:8453', '8453'],
    nativeSymbol: 'ETH',
    rpcUrl: 'https://mainnet.base.org',
    x402: true,
  },
  {
    network: 'ethereum',
    family: 'evm',
    caip2: 'eip155:1',
    chainId: 1,
    aliases: ['ethereum', 'mainnet', 'eth', 'eip155:1', '1'],
    nativeSymbol: 'ETH',
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    x402: false,
  },
  {
    network: 'base-sepolia',
    family: 'evm',
    caip2: 'eip155:84532',
    chainId: 84532,
    aliases: ['base-sepolia', 'basesepolia', 'eip155:84532', '84532'],
    nativeSymbol: 'ETH',
    rpcUrl: 'https://sepolia.base.org',
    x402: true,
  },
  {
    network: 'solana',
    family: 'svm',
    caip2: SOLANA_MAINNET,
    chainId: 0,
    aliases: ['solana', 'solana-mainnet', 'solana-mainnet-beta', SOLANA_MAINNET.toLowerCase()],
    nativeSymbol: 'SOL',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    x402: true,
  },
  {
    network: 'solana-devnet',
    family: 'svm',
    caip2: SOLANA_DEVNET,
    chainId: 0,
    aliases: ['solana-devnet', 'devnet', SOLANA_DEVNET.toLowerCase()],
    nativeSymbol: 'SOL',
    rpcUrl: 'https://api.devnet.solana.com',
    x402: true,
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
  /** Token contract on EVM, mint address on SVM. */
  address: string;
  decimals: number;
  /** CAIP-2 of the chain this token lives on. */
  caip2: string;
  /** EIP-712 domain fields for EIP-3009. EVM only. */
  eip712?: { name: string; version: string };
}

/**
 * Whether two addresses of this family name the same account.
 *
 * EVM addresses are hex and only their checksum casing varies, so they compare
 * case-insensitively. A Solana address is base58, where case is part of the
 * value: folding it would let `AbC...` match a different account, which would
 * turn an allowlist entry into a match for an address nobody approved.
 */
export function sameAddress(family: ChainFamily, a: string, b: string): boolean {
  return family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export const ASSETS: AssetInfo[] = [
  {
    symbol: 'usdc',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    caip2: 'eip155:8453',
    eip712: { name: 'USD Coin', version: '2' },
  },
  {
    symbol: 'usdc',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    caip2: 'eip155:1',
    // Read from the contract, not copied from a doc: name() "USD Coin",
    // version() "2", decimals() 6, and DOMAIN_SEPARATOR() present.
    eip712: { name: 'USD Coin', version: '2' },
  },
  {
    symbol: 'usdc',
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    decimals: 6,
    caip2: 'eip155:84532',
    eip712: { name: 'USDC', version: '2' },
  },
  {
    symbol: 'usdc',
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    caip2: SOLANA_MAINNET,
  },
  {
    symbol: 'usdc',
    address: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    decimals: 6,
    caip2: SOLANA_DEVNET,
  },
];

/**
 * Find a known token on a chain. The chain is how the family is known, so the
 * address is compared the way that family compares addresses.
 */
export function findAsset(address: string | undefined, chain?: ChainInfo): AssetInfo | undefined {
  if (!address) return undefined;
  const symbol = address.toLowerCase();
  return ASSETS.find((a) => {
    if (chain !== undefined && a.caip2 !== chain.caip2) return false;
    if (a.symbol === symbol) return true;
    const family = CHAINS.find((c) => c.caip2 === a.caip2)?.family ?? 'evm';
    return sameAddress(family, a.address, address);
  });
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

/**
 * Parse a decimal amount into atomic units. Throws on more precision than the
 * asset has.
 *
 * Numbers are accepted as well as strings, because JSON has no string type for
 * money and `config set limits.maxPerCall 0.05` writes a JSON number: reading
 * it back used to crash with `value.trim is not a function`, turning a
 * configured spend cap into an unusable one. Anything non-decimal — including
 * the `1e-7` a very small number stringifies to — is still refused rather than
 * guessed at.
 */
export function parseUnits(value: string | number, decimals: number): bigint {
  const trimmed = String(value).trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error(`not a decimal amount: ${String(value)}`);
  }
  const negative = trimmed.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  if (frac.length > decimals) {
    throw new Error(`amount ${String(value)} has more than ${decimals} decimal places`);
  }
  const atomic =
    BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return negative ? -atomic : atomic;
}
