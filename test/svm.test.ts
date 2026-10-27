import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as web3 from '@solana/web3.js';
import { decodeBase58, encodeBase58, isSolanaAddress } from '../src/core/base58.js';
import { ASSETS, SOLANA_MAINNET, findAsset, findChain, sameAddress } from '../src/core/assets.js';
import { DEFAULT_CONFIG, mergeDeep, type X402Config } from '../src/core/config.js';
import { Engine } from '../src/core/engine.js';
import { ExitCode, X402Error } from '../src/core/errors.js';
import { decodePaymentHeader, type SvmSchemePayload } from '../src/core/eip3009.js';
import { authKey } from '../src/core/authcache.js';
import { runGates } from '../src/core/gates.js';
import { SolanaEnvSigner, parseSolanaSecret } from '../src/core/signers/solanaenv.js';
import {
  associatedTokenAddress,
  attachPayerSignature,
  buildSvmTransaction,
  fetchLatestBlockhash,
  verifySvmTransaction,
} from '../src/core/svm.js';
import { parsePaymentRequired, type PaymentOption } from '../src/core/x402.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BLOCKHASH = encodeBase58(randomBytes(32));
const random = () => encodeBase58(randomBytes(32));
const PAY_TO = random();
const FEE_PAYER = random();

/** A funded-looking payer: a real ed25519 key, in the 64-byte form wallets export. */
function newSecret(): { secret: Uint8Array; address: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(String(privateKey.export({ format: 'jwk' }).d), 'base64url');
  const pub = Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url');
  return { secret: Uint8Array.from([...seed, ...pub]), address: encodeBase58(pub) };
}

const quote = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact',
  network: 'solana',
  maxAmountRequired: '2000',
  payTo: PAY_TO,
  asset: MINT,
  maxTimeoutSeconds: 60,
  extra: { feePayer: FEE_PAYER },
  ...over,
});

const optionOf = (over: Record<string, unknown> = {}): PaymentOption =>
  parsePaymentRequired({ x402Version: 1, accepts: [quote(over)] }).options[0]!;

describe('base58', () => {
  it('round-trips, keeping leading zero bytes', () => {
    for (const bytes of [randomBytes(32), Buffer.from([0, 0, 1, 2, 3]), Buffer.alloc(32)]) {
      expect(Buffer.from(decodeBase58(encodeBase58(bytes)))).toEqual(bytes);
    }
  });

  it('recognises a 32-byte address and nothing else', () => {
    expect(isSolanaAddress(MINT)).toBe(true);
    expect(isSolanaAddress('0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd')).toBe(false);
    expect(isSolanaAddress('short')).toBe(false);
    expect(isSolanaAddress(`${MINT}0`)).toBe(false); // 0 is not in the alphabet
  });
});

describe('the Solana tables', () => {
  it('carries mainnet and devnet USDC with their decimals', () => {
    const usdc = ASSETS.filter((a) => a.caip2.startsWith('solana:'));
    expect(usdc).toHaveLength(2);
    expect(usdc.every((a) => a.decimals === 6 && a.eip712 === undefined)).toBe(true);
    expect(findAsset(MINT, findChain('solana'))?.symbol).toBe('usdc');
  });

  it('resolves the CAIP-2 spelling a v2 quote uses', () => {
    expect(findChain(SOLANA_MAINNET)?.network).toBe('solana');
    expect(findChain('solana-devnet')?.family).toBe('svm');
  });

  it('compares Solana addresses case-sensitively and EVM ones without case', () => {
    expect(sameAddress('evm', '0xAbC', '0xabc')).toBe(true);
    expect(sameAddress('svm', 'AbC', 'abc')).toBe(false);
  });

  it('does not find a mint by its lower-cased spelling', () => {
    expect(findAsset(MINT.toLowerCase(), findChain('solana'))).toBeUndefined();
  });
});

describe('reading a Solana 402', () => {
  it('accepts a v1 quote and a v2 CAIP-2 quote', () => {
    const v1 = optionOf();
    expect(v1).toMatchObject({
      family: 'svm',
      chain: SOLANA_MAINNET,
      asset: MINT,
      amountAtomic: 2000n,
      feePayer: FEE_PAYER,
    });
    expect(v1.eip712).toBeUndefined();
    const v2 = parsePaymentRequired({
      x402Version: 2,
      accepts: [quote({ network: SOLANA_MAINNET, amount: '2000', maxAmountRequired: undefined })],
    }).options[0]!;
    expect(v2.chain).toBe(SOLANA_MAINNET);
  });

  const refused = (over: Record<string, unknown>, pattern: RegExp) => {
    try {
      optionOf(over);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(X402Error);
      expect((err as X402Error).code).toBe(ExitCode.INVALID_402);
      expect((err as Error).message).toMatch(pattern);
    }
  };

  it('refuses a quote with no fee payer, or one that is not an address', () => {
    refused({ extra: {} }, /feePayer/);
    refused({ extra: { feePayer: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd' } }, /feePayer/);
  });

  it('refuses an EVM payTo on Solana, and a Solana payTo on Base', () => {
    refused({ payTo: '0x1831f336585a6C67B6A954d28f3E07F44C4EEBbd' }, /payTo/);
    refused(
      {
        network: 'base',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        extra: { name: 'USD Coin', version: '2' },
      },
      /payTo/,
    );
  });

  it('refuses a mint it does not know, and one with the declared decimals changed', () => {
    refused({ asset: random() }, /not a token this CLI knows/);
    refused({ extra: { feePayer: FEE_PAYER, decimals: 9 } }, /declares 9 decimals/);
  });
});

describe('the solana-env signer', () => {
  it('reads a base58 key and a JSON byte array, and signs for the right address', async () => {
    const { secret, address } = newSecret();
    for (const text of [encodeBase58(secret), JSON.stringify([...secret])]) {
      const signer = new SolanaEnvSigner('env', {}, { X402_SOLANA_PRIVATE_KEY: text });
      expect(await signer.getAddress()).toBe(address);
      expect((await signer.capabilities()).svm).toBe(true);
    }
  });

  it('refuses a key whose public half does not match, without printing it', () => {
    const { secret } = newSecret();
    const bad = Uint8Array.from([...secret.subarray(0, 32), ...randomBytes(32)]);
    const signer = new SolanaEnvSigner('env', {}, { X402_SOLANA_PRIVATE_KEY: encodeBase58(bad) });
    return expect(signer.getAddress()).rejects.toThrow(/does not match its seed/);
  });

  it('never quotes a malformed key back', () => {
    try {
      parseSolanaSecret('this-is-not-a-key-0OIl');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('this-is-not-a-key');
    }
  });

  it('says so when the variable is not set', async () => {
    const signer = new SolanaEnvSigner('env', {}, {});
    await expect(signer.getAddress()).rejects.toThrow(/X402_SOLANA_PRIVATE_KEY/);
  });

  it('refuses typed data', async () => {
    const { secret } = newSecret();
    const signer = new SolanaEnvSigner(
      'env',
      {},
      { X402_SOLANA_PRIVATE_KEY: encodeBase58(secret) },
    );
    await expect(signer.signTypedData({} as never)).rejects.toThrow(/not EIP-712/);
  });
});

/** Build, sign and return a payment, so a test can start from a valid one and break it. */
async function signedPayment(over: Record<string, unknown> = {}) {
  const { secret, address } = newSecret();
  const signer = new SolanaEnvSigner('env', {}, { X402_SOLANA_PRIVATE_KEY: encodeBase58(secret) });
  const option = optionOf(over);
  const built = await buildSvmTransaction({ option, payer: address, blockhash: BLOCKHASH, now: 1 });
  const signature = await signer.signSvmMessage(built.message);
  const transaction = await attachPayerSignature(built, address, signature);
  return { option, payer: address, transaction, signer, built };
}

describe('verifying the transaction before it is released', () => {
  let stderr: MockInstance<typeof process.stderr.write>;
  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => stderr.mockRestore());

  it('passes the payment that was built for the quote', async () => {
    const { option, payer, transaction } = await signedPayment();
    await expect(
      verifySvmTransaction({ option, payer, transaction, blockhash: BLOCKHASH }),
    ).resolves.toBeUndefined();
  });

  it('leaves the fee payer slot empty for the facilitator to fill', async () => {
    const { transaction } = await signedPayment();
    const tx = web3.VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
    expect(tx.signatures[0]!.every((b) => b === 0)).toBe(true);
    expect(tx.signatures[1]!.some((b) => b !== 0)).toBe(true);
  });

  /**
   * Rebuild the payment with one thing changed, sign it honestly with the payer's
   * key, and check the verifier still says no. The signature is valid in every
   * case: it is the content that is wrong, which is the case worth proving.
   */
  async function tampered(change: {
    instructions?: (
      ix: web3.TransactionInstruction[],
      ctx: { payer: string; ata: (owner: string, mint?: string) => Promise<string> },
    ) => web3.TransactionInstruction[] | Promise<web3.TransactionInstruction[]>;
    feePayer?: string;
    option?: Partial<PaymentOption>;
    /** Skip the payer signature, for a message the payer cannot sign at all. */
    unsigned?: boolean;
  }) {
    const { secret, address } = newSecret();
    const signer = new SolanaEnvSigner(
      'env',
      {},
      { X402_SOLANA_PRIVATE_KEY: encodeBase58(secret) },
    );
    const option = optionOf();
    const honest = await buildSvmTransaction({
      option,
      payer: address,
      blockhash: BLOCKHASH,
      now: 1,
    });
    const decoded = web3.VersionedTransaction.deserialize(
      Buffer.from(honest.transaction, 'base64'),
    );
    const keys = decoded.message.staticAccountKeys;
    const original = web3.TransactionMessage.decompile(decoded.message).instructions;
    const web3Ata = (owner: string, mint = MINT) =>
      associatedTokenAddress(web3 as never, owner, mint);
    const instructions = change.instructions
      ? await change.instructions(original, { payer: address, ata: web3Ata })
      : original;
    const message = new web3.TransactionMessage({
      payerKey: new web3.PublicKey(change.feePayer ?? option.feePayer!),
      recentBlockhash: BLOCKHASH as never,
      instructions,
    }).compileToV0Message();
    void keys;
    const built = {
      message: message.serialize(),
      transaction: Buffer.from(new web3.VersionedTransaction(message).serialize()).toString(
        'base64',
      ),
      blockhash: BLOCKHASH,
      validBefore: 1,
    };
    const transaction = change.unsigned
      ? built.transaction
      : await attachPayerSignature(built, address, await signer.signSvmMessage(built.message));
    return verifySvmTransaction({
      option: { ...option, ...change.option },
      payer: address,
      transaction,
      blockhash: BLOCKHASH,
    });
  }

  const transferData = (amount: bigint, decimals = 6) => {
    const data = Buffer.alloc(10);
    data[0] = 12;
    data.writeBigUInt64LE(amount, 1);
    data[9] = decimals;
    return data;
  };

  const transferWith = (
    ctx: { payer: string },
    source: string,
    mint: string,
    destination: string,
    data: Buffer,
  ) =>
    new web3.TransactionInstruction({
      programId: new web3.PublicKey(TOKEN_PROGRAM),
      keys: [
        { pubkey: new web3.PublicKey(source), isSigner: false, isWritable: true },
        { pubkey: new web3.PublicKey(mint), isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(destination), isSigner: false, isWritable: true },
        { pubkey: new web3.PublicKey(ctx.payer), isSigner: true, isWritable: false },
      ],
      data,
    });

  it('refuses a transaction that moves no tokens, the flaw this exists to stop', async () => {
    // Two budget instructions and nothing else: the payer is not even a signer.
    await expect(
      tampered({ instructions: (ix) => ix.slice(0, 2), unsigned: true }),
    ).rejects.toThrow(/exactly the fee payer and the payer/);
    await expect(
      tampered({
        instructions: (ix, ctx) => [
          ...ix.slice(0, 2),
          web3.SystemProgram.transfer({
            fromPubkey: new web3.PublicKey(ctx.payer),
            toPubkey: new web3.PublicKey(PAY_TO),
            lamports: 1,
          }),
        ],
      }),
    ).rejects.toThrow(/not an SPL token instruction/);
  });

  it('refuses a transfer of a different amount, in either direction', async () => {
    for (const amount of [1999n, 2001n, 0n]) {
      await expect(
        tampered({
          instructions: async (ix, ctx) => [
            ...ix.slice(0, 2),
            transferWith(
              ctx,
              await ctx.ata(ctx.payer),
              MINT,
              await ctx.ata(PAY_TO),
              transferData(amount),
            ),
          ],
        }),
      ).rejects.toThrow(/amount other than the quoted one/);
    }
  });

  it('refuses the wrong mint, the wrong recipient, and someone else’s source account', async () => {
    const otherMint = random();
    await expect(
      tampered({
        instructions: async (ix, ctx) => [
          ...ix.slice(0, 2),
          transferWith(
            ctx,
            await ctx.ata(ctx.payer, otherMint),
            otherMint,
            await ctx.ata(PAY_TO, otherMint),
            transferData(2000n),
          ),
        ],
      }),
    ).rejects.toThrow(/mint other than the quoted one/);
    await expect(
      tampered({
        instructions: async (ix, ctx) => [
          ...ix.slice(0, 2),
          transferWith(
            ctx,
            await ctx.ata(ctx.payer),
            MINT,
            await ctx.ata(random()),
            transferData(2000n),
          ),
        ],
      }),
    ).rejects.toThrow(/recipient's token account/);
    await expect(
      tampered({
        instructions: async (ix, ctx) => [
          ...ix.slice(0, 2),
          transferWith(
            ctx,
            await ctx.ata(random()),
            MINT,
            await ctx.ata(PAY_TO),
            transferData(2000n),
          ),
        ],
      }),
    ).rejects.toThrow(/payer's own token account/);
  });

  it('refuses wrong decimals, an extra instruction, and a priority fee above the ceiling', async () => {
    await expect(
      tampered({
        instructions: async (ix, ctx) => [
          ...ix.slice(0, 2),
          transferWith(
            ctx,
            await ctx.ata(ctx.payer),
            MINT,
            await ctx.ata(PAY_TO),
            transferData(2000n, 9),
          ),
        ],
      }),
    ).rejects.toThrow(/decimals/);
    await expect(tampered({ instructions: (ix) => [...ix, ix[2]!] })).rejects.toThrow(
      /4 instructions/,
    );
    await expect(
      tampered({
        instructions: (ix) => [
          ix[0]!,
          web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
          ix[2]!,
        ],
      }),
    ).rejects.toThrow(/above the ceiling/);
    await expect(
      tampered({
        instructions: (ix) => [
          web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ix[1]!,
          ix[2]!,
        ],
      }),
    ).rejects.toThrow(/compute unit limit/);
  });

  it('refuses a fee payer other than the one the 402 named', async () => {
    await expect(tampered({ feePayer: random() })).rejects.toThrow(/fee payer is not the account/);
  });

  it('refuses a payer signature that does not belong to the message', async () => {
    const { option, payer, transaction } = await signedPayment();
    const tx = web3.VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
    tx.signatures[1] = Uint8Array.from(randomBytes(64));
    await expect(
      verifySvmTransaction({
        option,
        payer,
        transaction: Buffer.from(tx.serialize()).toString('base64'),
        blockhash: BLOCKHASH,
      }),
    ).rejects.toThrow(/signature is not valid/);
  });

  it('refuses a transaction whose fee payer slot is already filled', async () => {
    const { option, payer, transaction } = await signedPayment();
    const tx = web3.VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
    tx.signatures[0] = Uint8Array.from(randomBytes(64));
    await expect(
      verifySvmTransaction({
        option,
        payer,
        transaction: Buffer.from(tx.serialize()).toString('base64'),
        blockhash: BLOCKHASH,
      }),
    ).rejects.toThrow(/fee payer slot is already filled/);
  });

  it('refuses a transaction built for a different blockhash, and one that is not a transaction', async () => {
    const { option, payer, transaction } = await signedPayment();
    await expect(
      verifySvmTransaction({ option, payer, transaction, blockhash: random() }),
    ).rejects.toThrow(/blockhash/);
    await expect(
      verifySvmTransaction({ option, payer, transaction: 'AAAA', blockhash: BLOCKHASH }),
    ).rejects.toThrow(/does not decode/);
  });
});

describe('what keeps one payment from being two', () => {
  const base = {
    url: 'https://api.example.com/v1/x',
    method: 'GET',
    body: '',
    amountAtomic: 2000n,
    wallet: 'w',
    backend: 'b',
    x402Version: 1,
    family: 'svm' as const,
  };

  it('keys a Solana authorization on the exact case of the recipient and the mint', () => {
    const a = authKey({ ...base, payTo: 'AbCdEf', asset: MINT, chain: SOLANA_MAINNET });
    const b = authKey({ ...base, payTo: 'abcdef', asset: MINT, chain: SOLANA_MAINNET });
    expect(a).not.toBe(b);
  });

  it('still folds case for EVM, so an existing cache entry is found', () => {
    const evm = { ...base, family: 'evm' as const, chain: 'eip155:8453' };
    expect(authKey({ ...evm, payTo: '0xAB', asset: '0xCD' })).toBe(
      authKey({ ...evm, payTo: '0xab', asset: '0xcd' }),
    );
  });

  it('matches a payTo allowlist exactly on Solana', () => {
    const option = optionOf();
    const gate = (allow: string[]) =>
      runGates({ option, url: 'https://api.example.com/x', allowPayTo: allow });
    expect(() => gate([PAY_TO])).not.toThrow();
    expect(() => gate([PAY_TO.toLowerCase()])).toThrow(/payTo not in allowlist/);
  });
});

describe('paying on Solana end to end', () => {
  let home: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let stderr: MockInstance<typeof process.stderr.write>;
  const URL_ = 'https://api.example.com/v1/lei';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'x402-svm-'));
    process.env.X402_HOME = home;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    stderr.mockRestore();
    delete process.env.X402_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const rpcOk = () =>
    new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  function engineFor(overrides: Partial<X402Config> = {}) {
    const { secret } = newSecret();
    const signer = new SolanaEnvSigner(
      'env',
      {},
      { X402_SOLANA_PRIVATE_KEY: encodeBase58(secret) },
    );
    const config = mergeDeep(DEFAULT_CONFIG, {
      defaults: { chain: 'solana' },
      ...overrides,
    });
    return new Engine({
      config,
      signer: async () => signer,
      walletName: signer.wallet,
      backendName: signer.backend,
      now: () => 1_700_000_000_000,
    });
  }

  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  it('quotes, fetches a blockhash, signs a verified transaction and retries with it', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, { x402Version: 1, accepts: [quote()] }))
      .mockResolvedValueOnce(rpcOk())
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    const result = await engineFor().call({ target: URL_ });
    expect(result.paid).toBe(true);
    expect(result.receipt?.chain).toBe(SOLANA_MAINNET);
    expect(result.receipt?.payTo).toBe(PAY_TO);

    const retry = fetchMock.mock.calls[2]![1] as { headers: Record<string, string> };
    const header = retry.headers['x-payment'] ?? retry.headers['X-PAYMENT'];
    const payload = decodePaymentHeader(header!) as unknown as {
      scheme: string;
      network: string;
      payload: SvmSchemePayload;
    };
    expect(payload).toMatchObject({ scheme: 'exact', network: 'solana' });
    const tx = web3.VersionedTransaction.deserialize(
      Buffer.from(payload.payload.transaction, 'base64'),
    );
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(FEE_PAYER);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('solana-env'));
  });

  it('refuses a quote over --max before any network call, so no blockhash is fetched', async () => {
    fetchMock.mockResolvedValueOnce(
      json(402, { x402Version: 1, accepts: [quote({ maxAmountRequired: '5000000' })] }),
    );
    const result = await engineFor().call({ target: URL_ });
    expect(result.errorCode).toBe(ExitCode.OVER_MAX);
    expect(urls()).toEqual([URL_]);
  });

  it('reuses the cached transaction on a retry rather than building a second one', async () => {
    const engine = engineFor();
    fetchMock
      .mockResolvedValueOnce(json(402, { x402Version: 1, accepts: [quote()] }))
      .mockResolvedValueOnce(rpcOk())
      .mockResolvedValueOnce(new Response('upstream down', { status: 502 }));
    const first = await engine.call({ target: URL_ });
    expect(first.ok).toBe(false);

    fetchMock
      .mockResolvedValueOnce(json(402, { x402Version: 1, accepts: [quote()] }))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    const second = await engine.call({ target: URL_ });
    expect(second.paid).toBe(true);
    expect(second.cacheHit).toBe(true);
    expect(urls().filter((u) => u.includes('solana.com'))).toHaveLength(1);
    const sent = (i: number) =>
      (fetchMock.mock.calls[i]![1] as { headers: Record<string, string> }).headers;
    expect(sent(2)['x-payment']).toBe(sent(4)['x-payment']);
  });

  it('fails clearly, and signs nothing, when no blockhash can be read', async () => {
    fetchMock
      .mockResolvedValueOnce(json(402, { x402Version: 1, accepts: [quote()] }))
      .mockResolvedValueOnce(json(200, { jsonrpc: '2.0', id: 1, error: { message: 'busy' } }));
    const result = await engineFor().call({ target: URL_ });
    expect(result.paid).toBe(false);
    expect(result.error).toMatch(/no blockhash/);
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('WARNING signing'));
  });

  it('refuses before signing when the backend cannot sign a Solana transaction', async () => {
    const evmOnly = {
      backend: 'evm-only',
      wallet: 'w',
      capabilities: async () => ({
        typedData: true,
        policies: false,
        balances: false,
        accounts: true,
        declared: true,
      }),
      getAccounts: async () => [],
      getAddress: async () => '0x000000000000000000000000000000000000dEaD',
      signTypedData: vi.fn(async () => '0x'),
    };
    const engine = new Engine({
      config: mergeDeep(DEFAULT_CONFIG, { defaults: { chain: 'solana' } }),
      signer: async () => evmOnly,
      walletName: 'w',
      backendName: 'evm-only',
      now: () => 1_700_000_000_000,
    });
    fetchMock.mockResolvedValueOnce(json(402, { x402Version: 1, accepts: [quote()] }));
    const result = await engine.call({ target: URL_ });
    expect(result.errorCode).toBe(ExitCode.OWS_UNREACHABLE);
    expect(evmOnly.signTypedData).not.toHaveBeenCalled();
  });

  it('reads the blockhash from the configured endpoint', async () => {
    fetchMock.mockResolvedValueOnce(rpcOk());
    await fetchLatestBlockhash('https://rpc.example.com/solana');
    expect(urls()).toEqual(['https://rpc.example.com/solana']);
  });
});
