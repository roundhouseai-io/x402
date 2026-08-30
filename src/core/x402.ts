import { X402Error, ExitCode } from './errors.js';
import { ASSETS, CHAINS, caip2, findAsset, findChain, formatUnits, parseUnits } from './assets.js';

export interface PaymentOption {
  scheme: string;
  /** Network name as the provider spelled it. */
  network: string;
  chainId: number;
  /** CAIP-2, e.g. eip155:8453. */
  chain: string;
  /** Token contract address. */
  asset: string;
  assetSymbol: string;
  decimals: number;
  amountAtomic: bigint;
  /** Human decimal amount, e.g. "0.002". */
  amount: string;
  payTo: string;
  resource: string | undefined;
  description: string | undefined;
  maxTimeoutSeconds: number;
  /** EIP-712 domain name/version for the token contract. */
  eip712: { name: string; version: string };
  raw: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  error: string | undefined;
  options: PaymentOption[];
  raw: unknown;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** First present key, tolerating the naming drift seen across live providers. */
function pick(obj: Json, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

const A_AMOUNT = ['maxAmountRequired', 'amountRequired', 'maxAmount', 'amount', 'price', 'value'];
const A_PAYTO = ['payTo', 'payto', 'recipient', 'payee', 'address', 'to'];
const A_NETWORK = ['network', 'chain', 'chainId', 'networkId'];
const A_ASSET = ['asset', 'token', 'tokenAddress', 'currency', 'contract'];
const A_SCHEME = ['scheme', 'type'];

function normalizeOption(input: unknown, index: number): PaymentOption {
  if (!isObj(input)) {
    throw new X402Error(ExitCode.INVALID_402, `payment option ${index} is not an object`);
  }

  const scheme = String(pick(input, A_SCHEME) ?? 'exact');

  const rawNetwork = pick(input, A_NETWORK);
  const chain = findChain(rawNetwork as string | number | undefined);
  if (!chain) {
    throw new X402Error(
      ExitCode.INVALID_402,
      `unsupported or missing network in 402 payload: ${JSON.stringify(rawNetwork ?? null)}`,
      { supported: CHAINS.map((c) => c.network) },
    );
  }

  // Readable is not the same as payable. Ethereum mainnet is in the chain table
  // so `wallet balance` can see funds there; settling an x402 payment on it
  // would cost a multiple of the payment in gas, for no benefit over Base.
  if (!chain.x402) {
    throw new X402Error(
      ExitCode.INVALID_402,
      `${chain.network} is not a chain this CLI pays on. x402 settles on ` +
        `${CHAINS.filter((c) => c.x402)
          .map((c) => c.network)
          .join(', ')}; ${chain.network} is readable by \`wallet balance\` only.`,
      { network: chain.network, payable: CHAINS.filter((c) => c.x402).map((c) => c.network) },
    );
  }

  const payTo = pick(input, A_PAYTO);
  if (typeof payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    throw new X402Error(ExitCode.INVALID_402, `missing or malformed payTo in 402 payload`);
  }

  const extra = isObj(input.extra) ? input.extra : {};
  const assetRaw = pick(input, A_ASSET);
  const known = findAsset(typeof assetRaw === 'string' ? assetRaw : undefined, chain.chainId);
  if (assetRaw === undefined || assetRaw === '') {
    throw new X402Error(ExitCode.INVALID_402, `missing asset address in 402 payload`, {
      asset: assetRaw ?? null,
    });
  }

  // The asset must be one this CLI knows on this chain. Two reasons, and the
  // second is the one that costs money:
  //
  //   - An unknown contract has no trustworthy decimals and no trustworthy
  //     EIP-712 domain, so the only source for both is the counterparty.
  //   - `--max` is compared in atomic units, scaled by those decimals. A
  //     provider that quotes a real 6-decimal token while declaring 18 gets a
  //     cap 10^12 times too large, and `--max 0.05` waves through a demand for
  //     fifty billion. The gate reads as if it held.
  //
  // So an unfamiliar token is refused rather than priced on the seller's word.
  // Adding one is a table entry in `core/assets.ts` with the decimals and the
  // EIP-712 domain read from the contract.
  if (!known) {
    const onChain = ASSETS.filter((a) => a.chainId === chain.chainId);
    throw new X402Error(
      ExitCode.INVALID_402,
      `asset ${String(assetRaw)} is not a token this CLI knows on ${chain.network}. ` +
        `Known there: ${onChain.map((a) => `${a.symbol} (${a.address})`).join(', ') || 'none'}. ` +
        `Pricing an unknown token means trusting the provider's own decimals, which is what --max is meant to check.`,
      { asset: assetRaw ?? null, network: chain.network, known: onChain.map((a) => a.symbol) },
    );
  }

  const assetAddr = known.address;
  // Decimals come from the table, never the payload. A payload that disagrees
  // is either a provider bug or an attempt to rescale the gate; both are worth
  // failing on rather than guessing which.
  const decimalsRaw = pick({ ...input, ...extra }, ['decimals', 'assetDecimals']);
  const decimals = known.decimals;
  if (decimalsRaw !== undefined && Number(decimalsRaw) !== decimals) {
    throw new X402Error(
      ExitCode.INVALID_402,
      `402 declares ${String(decimalsRaw)} decimals for ${known.symbol}, which has ${decimals}. ` +
        `Refusing rather than pricing the call on the declared value.`,
      { asset: assetAddr, declared: decimalsRaw, actual: decimals },
    );
  }

  const amountRaw = pick(input, A_AMOUNT);
  if (amountRaw === undefined) {
    throw new X402Error(ExitCode.INVALID_402, 'missing amount in 402 payload');
  }
  const amountStr = String(amountRaw);
  let amountAtomic: bigint;
  try {
    // A dotted value is a human amount; a bare integer is atomic units.
    amountAtomic = amountStr.includes('.') ? parseUnits(amountStr, decimals) : BigInt(amountStr);
  } catch (err) {
    throw new X402Error(
      ExitCode.INVALID_402,
      `unparseable amount "${amountStr}": ${(err as Error).message}`,
    );
  }
  if (amountAtomic < 0n)
    throw new X402Error(ExitCode.INVALID_402, 'negative amount in 402 payload');

  const timeout = Number(
    pick(input, ['maxTimeoutSeconds', 'timeoutSeconds', 'validForSeconds']) ?? 60,
  );

  return {
    scheme,
    network: typeof rawNetwork === 'string' ? rawNetwork : chain.network,
    chainId: chain.chainId,
    chain: caip2(chain.chainId),
    asset: assetAddr,
    assetSymbol: known.symbol,
    decimals,
    amountAtomic,
    amount: formatUnits(amountAtomic, decimals),
    payTo,
    resource: typeof input.resource === 'string' ? input.resource : undefined,
    description: typeof input.description === 'string' ? input.description : undefined,
    maxTimeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 60,
    // From the table too. `extra` is the provider describing a contract it does
    // not own; the table's values were read from the contract itself.
    eip712: { name: known.eip712.name, version: known.eip712.version },
    raw: input,
  };
}

/**
 * x402 v2 moved the payment requirements out of the body and into a header,
 * base64-encoded, in one of two spellings:
 *
 * ```
 * Payment-Required: eyJ4NDAyVmVyc2lvbiI6Miwi...
 * WWW-Authenticate: X402 requirements="eyJ4NDAyVmVyc2lvbiI6Miwi..."
 * ```
 *
 * Providers that do this leave a human-readable stub in the body — often with a
 * rounded or stale price — so the header is authoritative where both are present.
 * Returns undefined when neither header carries a decodable payload, leaving the
 * body as the v1 path.
 */
export function requirementsFromHeaders(headers: Record<string, string>): unknown | undefined {
  const candidates: string[] = [];

  const direct = headers['payment-required'];
  if (direct) candidates.push(direct.trim());

  const auth = headers['www-authenticate'];
  if (auth) {
    // `X402 requirements="<base64>"`, quoted or bare.
    const m = /x402\s+requirements\s*=\s*"?([A-Za-z0-9+/_=-]+)"?/i.exec(auth);
    if (m?.[1]) candidates.push(m[1]);
  }

  for (const raw of candidates) {
    try {
      const json = Buffer.from(raw, 'base64').toString('utf8');
      const parsed: unknown = JSON.parse(json);
      // A payload with no options is no better than the body; let the body try.
      if (isObj(parsed) || Array.isArray(parsed)) return parsed;
    } catch {
      // Not decodable — fall through to the next candidate, then to the body.
    }
  }
  return undefined;
}

/**
 * Parse an x402 402 body. Accepts the canonical `{x402Version, accepts:[...]}`
 * envelope, a bare requirements object, or a bare array of options — the three
 * shapes live providers actually emit today.
 */
export function parsePaymentRequired(body: unknown): PaymentRequired {
  let candidates: unknown[];
  let version = 1;
  let error: string | undefined;

  if (Array.isArray(body)) {
    candidates = body;
  } else if (isObj(body)) {
    version = Number(body.x402Version ?? body.version ?? 1);
    error = typeof body.error === 'string' ? body.error : undefined;
    const accepts = pick(body, ['accepts', 'paymentRequirements', 'options', 'requirements']);
    if (Array.isArray(accepts)) candidates = accepts;
    else if (isObj(accepts)) candidates = [accepts];
    else candidates = [body];
  } else {
    throw new X402Error(ExitCode.INVALID_402, 'response body is not a 402 payment payload');
  }

  if (candidates.length === 0) {
    throw new X402Error(ExitCode.INVALID_402, '402 payload lists no payment options');
  }

  const options: PaymentOption[] = [];
  const problems: string[] = [];
  for (const [i, c] of candidates.entries()) {
    try {
      options.push(normalizeOption(c, i));
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  if (options.length === 0) {
    throw new X402Error(ExitCode.INVALID_402, `no usable payment option: ${problems.join('; ')}`, {
      problems,
    });
  }

  return { x402Version: Number.isFinite(version) ? version : 1, error, options, raw: body };
}

export interface SelectOptions {
  /** Acceptable chains (names, aliases or CAIP-2). Empty means any supported. */
  chains?: string[];
  /** Preferred chain from config `defaults.chain`, tried before price. */
  preferChain?: string;
  /** Schemes this build can settle. */
  schemes?: string[];
}

/**
 * Selection order per spec 12.4: preferred chain first, then cheapest.
 * Ties break on the provider's own ordering, which keeps selection deterministic.
 */
export function selectOption(required: PaymentRequired, opts: SelectOptions = {}): PaymentOption {
  const schemes = opts.schemes ?? ['exact'];
  let pool = required.options.filter((o) => schemes.includes(o.scheme));
  if (pool.length === 0) {
    throw new X402Error(
      ExitCode.INVALID_402,
      `no supported payment scheme (offered: ${[...new Set(required.options.map((o) => o.scheme))].join(', ')})`,
    );
  }

  if (opts.chains && opts.chains.length > 0) {
    const allowed = new Set(
      opts.chains.map((c) => findChain(c)?.chainId).filter((id): id is number => id !== undefined),
    );
    const filtered = pool.filter((o) => allowed.has(o.chainId));
    if (filtered.length === 0) {
      throw new X402Error(
        ExitCode.INVALID_402,
        `no payment option on allowed chains (offered: ${[...new Set(pool.map((o) => o.network))].join(', ')})`,
      );
    }
    pool = filtered;
  }

  const preferred = findChain(opts.preferChain)?.chainId;
  const cheapest = (list: PaymentOption[]) =>
    list.reduce((best, o) => (o.amountAtomic < best.amountAtomic ? o : best), list[0]!);

  if (preferred !== undefined) {
    const onPreferred = pool.filter((o) => o.chainId === preferred);
    if (onPreferred.length > 0) return cheapest(onPreferred);
  }
  return cheapest(pool);
}
