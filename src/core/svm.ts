import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { X402Error, ExitCode } from './errors.js';
import { decodeBase58 } from './base58.js';
import { request } from './http.js';
import type { PaymentOption } from './x402.js';

/**
 * The Solana half of the x402 `exact` scheme.
 *
 * The payment is a transaction, not an authorization: the payer builds it,
 * signs it, and hands it to the facilitator, which adds its own signature as the
 * fee payer and submits it. That inverts who holds the pen, and it is where
 * Solana clients and facilitators have gone wrong: a transaction that *looks*
 * like a payment is not one unless it moves the quoted amount of the quoted
 * mint to the quoted recipient.
 *
 * So nothing here trusts what it built. `verifySvmTransaction` takes the signed
 * bytes that will leave the machine, decodes them again from scratch, and
 * refuses to let them go unless every instruction is exactly the payment that
 * was quoted and nothing else. Signing happens before that check but the
 * transaction is never released until it passes.
 */

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** SPL Token `TransferChecked`. */
const TRANSFER_CHECKED = 12;
/** ComputeBudget `SetComputeUnitLimit` and `SetComputeUnitPrice`. */
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;

/**
 * Compute budget for the payment, and the ceiling the verifier enforces.
 *
 * The fee payer is the facilitator, and a priority fee is the one part of the
 * transaction that costs somebody real money without being the payment. A
 * transfer needs a few thousand units; these leave room and no more.
 */
export const SVM_COMPUTE_UNIT_LIMIT = 40_000;
export const SVM_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1n;
export const SVM_MAX_COMPUTE_UNIT_LIMIT = 200_000;
export const SVM_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 5n;

/**
 * How long a signed transaction must be treated as possibly still alive.
 *
 * This is the double-payment bound, not a politeness. The facilitator holds the
 * transaction and can submit it at any point until its blockhash expires, which
 * is 150 blocks: about a minute at the usual slot time, longer when slots run
 * slow. Until then a retry must reuse the cached transaction, because a fresh
 * one has a different blockhash and signature and could land as well. Two
 * minutes is past the longest plausible lifetime, so once the cache entry
 * expires the old transaction is dead and signing a new one cannot pay twice.
 */
export const SVM_VALID_SECONDS = 120;

export const SOLANA_INSTALL_HINT =
  'install it next to this CLI: `npm i @roundhouseai/x402 @solana/web3.js` in a project, ' +
  '`npm i -g @solana/web3.js` beside a global install, or run with ' +
  '`npx -p @roundhouseai/x402 -p @solana/web3.js rh-x402 ...`';

type Web3 = typeof import('@solana/web3.js');
type Blockhash = ConstructorParameters<Web3['TransactionMessage']>[0]['recentBlockhash'];

/**
 * Load `@solana/web3.js` on demand. Like `ethers`, it is an optional peer
 * dependency: a default install carries no Solana code, and the hot-wallet
 * surface of the CLI does not grow for anyone who pays on Base.
 */
export async function loadWeb3(): Promise<Web3> {
  // A non-literal specifier keeps the package out of the compile graph.
  const specifier = '@solana/web3.js';
  try {
    return (await import(specifier)) as Web3;
  } catch {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `paying on Solana needs the optional peer dependency \`@solana/web3.js\`: ${SOLANA_INSTALL_HINT}`,
    );
  }
}

/** Whether `@solana/web3.js` resolves from here, without throwing. */
export async function web3Available(): Promise<boolean> {
  try {
    await loadWeb3();
    return true;
  } catch {
    return false;
  }
}

export interface BuiltSvmTransaction {
  /** What the payer signs: the serialized transaction message. */
  message: Uint8Array;
  /** The base64 transaction the facilitator receives. */
  transaction: string;
  blockhash: string;
  /** Unix seconds after which this transaction should be treated as dead. */
  validBefore: number;
}

export interface BuildSvmInput {
  option: PaymentOption;
  /** The payer's address, base58. */
  payer: string;
  /** A recent blockhash from `fetchLatestBlockhash`. */
  blockhash: string;
  /** Unix seconds; injectable for tests. */
  now: number;
}

/** The associated token account `owner` holds `mint` in. */
export async function associatedTokenAddress(
  web3: Web3,
  owner: string,
  mint: string,
): Promise<string> {
  const [address] = await web3.PublicKey.findProgramAddress(
    [
      new web3.PublicKey(owner).toBytes(),
      new web3.PublicKey(TOKEN_PROGRAM).toBytes(),
      new web3.PublicKey(mint).toBytes(),
    ],
    new web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  );
  return address.toBase58();
}

function transferCheckedData(amount: bigint, decimals: number): Buffer {
  const data = Buffer.alloc(10);
  data[0] = TRANSFER_CHECKED;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return data;
}

/**
 * Build the unsigned payment: set the compute budget, then move `amount` of
 * `mint` from the payer's token account to the recipient's, with the facilitator
 * as fee payer. Nothing else goes in it.
 */
export async function buildSvmTransaction(input: BuildSvmInput): Promise<BuiltSvmTransaction> {
  const { option, payer, blockhash, now } = input;
  if (!option.feePayer) {
    throw new X402Error(ExitCode.INVALID_402, 'a Solana payment needs a fee payer from the 402');
  }
  if (option.amountAtomic > 0xffff_ffff_ffff_ffffn) {
    throw new X402Error(ExitCode.INVALID_402, 'the quoted amount does not fit a token amount');
  }
  const web3 = await loadWeb3();
  const key = (address: string) => new web3.PublicKey(address);

  const source = await associatedTokenAddress(web3, payer, option.asset);
  const destination = await associatedTokenAddress(web3, option.payTo, option.asset);

  const message = new web3.TransactionMessage({
    payerKey: key(option.feePayer),
    recentBlockhash: blockhash as Blockhash,
    instructions: [
      web3.ComputeBudgetProgram.setComputeUnitLimit({ units: SVM_COMPUTE_UNIT_LIMIT }),
      web3.ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: SVM_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
      }),
      new web3.TransactionInstruction({
        programId: key(TOKEN_PROGRAM),
        keys: [
          { pubkey: key(source), isSigner: false, isWritable: true },
          { pubkey: key(option.asset), isSigner: false, isWritable: false },
          { pubkey: key(destination), isSigner: false, isWritable: true },
          { pubkey: key(payer), isSigner: true, isWritable: false },
        ],
        data: transferCheckedData(option.amountAtomic, option.decimals),
      }),
    ],
  }).compileToV0Message();

  const transaction = new web3.VersionedTransaction(message);
  return {
    message: message.serialize(),
    transaction: Buffer.from(transaction.serialize()).toString('base64'),
    blockhash,
    validBefore: now + SVM_VALID_SECONDS,
  };
}

/**
 * Attach the payer's signature and return the serialized transaction.
 *
 * The fee payer's slot stays empty: it is the facilitator's to fill, and the
 * transaction is useless until it does.
 */
export async function attachPayerSignature(
  built: BuiltSvmTransaction,
  payer: string,
  signature: Uint8Array,
): Promise<string> {
  if (signature.length !== 64) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `the signer returned ${signature.length} bytes for an ed25519 signature, expected 64`,
    );
  }
  const web3 = await loadWeb3();
  const transaction = web3.VersionedTransaction.deserialize(
    Buffer.from(built.transaction, 'base64'),
  );
  transaction.addSignature(new web3.PublicKey(payer), signature);
  return Buffer.from(transaction.serialize()).toString('base64');
}

function refuse(reason: string): never {
  throw new X402Error(
    ExitCode.INVALID_402,
    `refusing to release the Solana payment: ${reason}. Nothing was sent.`,
  );
}

function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey).toString('base64url') },
    format: 'jwk',
  });
  return verifySignature(null, message, key, signature);
}

export interface VerifySvmInput {
  option: PaymentOption;
  payer: string;
  /** The base64 transaction that is about to be sent. */
  transaction: string;
  blockhash: string;
}

/**
 * Check the bytes that are about to leave the machine against the quote.
 *
 * The transaction is decoded again here rather than trusting the object that was
 * built, so what is verified is what is sent. It passes only if:
 *
 *   - it is a v0 transaction with no lookup tables, which would let an account
 *     be something other than the address written in the message;
 *   - the fee payer is the one the 402 named, and is not the payer;
 *   - exactly two accounts sign, the fee payer and the payer, and the payer's
 *     signature is genuine for this message while the fee payer's is still empty;
 *   - it has exactly three instructions: a compute unit limit, a compute unit
 *     price, and one SPL `TransferChecked`;
 *   - the budget is within bounds, so the fee payer is not made to overpay;
 *   - the transfer is of exactly the quoted amount and decimals, of the quoted
 *     mint, from the payer's own token account to the recipient's, authorized by
 *     the payer.
 *
 * That last line is what a "payment" that moves no tokens fails.
 */
export async function verifySvmTransaction(input: VerifySvmInput): Promise<void> {
  const { option, payer } = input;
  const web3 = await loadWeb3();

  let tx: InstanceType<Web3['VersionedTransaction']>;
  try {
    tx = web3.VersionedTransaction.deserialize(Buffer.from(input.transaction, 'base64'));
  } catch (err) {
    return refuse(`the transaction does not decode (${(err as Error).message})`);
  }

  const message = tx.message;
  if (tx.version !== 0 || !(message instanceof web3.MessageV0)) {
    return refuse('it is not a v0 transaction');
  }
  if (message.addressTableLookups.length > 0) {
    return refuse('it uses address lookup tables');
  }
  if (message.recentBlockhash !== input.blockhash) {
    return refuse('its blockhash is not the one it was built with');
  }

  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  const feePayer = option.feePayer;
  if (!feePayer || keys[0] !== feePayer) {
    return refuse('its fee payer is not the account the 402 named');
  }
  if (feePayer === payer) {
    return refuse('the fee payer is the payer');
  }

  const signers = message.header.numRequiredSignatures;
  if (signers !== 2 || keys[1] !== payer) {
    return refuse('it must be signed by exactly the fee payer and the payer');
  }
  const [feeSignature, payerSignature] = tx.signatures;
  if (!feeSignature || !payerSignature) return refuse('it is missing signature slots');
  if (feeSignature.some((byte) => byte !== 0)) {
    return refuse('the fee payer slot is already filled');
  }
  const payerKey = decodeBase58(payer);
  if (!ed25519Verify(payerKey, message.serialize(), payerSignature)) {
    return refuse('the payer signature is not valid for this transaction');
  }

  const instructions = message.compiledInstructions;
  if (instructions.length !== 3) {
    return refuse(`it has ${instructions.length} instructions, expected 3`);
  }
  const [limit, price, transfer] = instructions as [
    (typeof instructions)[number],
    (typeof instructions)[number],
    (typeof instructions)[number],
  ];
  const program = (ix: (typeof instructions)[number]) => keys[ix.programIdIndex];

  if (program(limit) !== COMPUTE_BUDGET_PROGRAM || limit.accountKeyIndexes.length !== 0) {
    return refuse('its first instruction is not a compute unit limit');
  }
  if (limit.data.length !== 5 || limit.data[0] !== SET_COMPUTE_UNIT_LIMIT) {
    return refuse('its first instruction is not a compute unit limit');
  }
  const units = Buffer.from(limit.data).readUInt32LE(1);
  if (units === 0 || units > SVM_MAX_COMPUTE_UNIT_LIMIT) {
    return refuse(`its compute unit limit ${units} is outside 1..${SVM_MAX_COMPUTE_UNIT_LIMIT}`);
  }

  if (program(price) !== COMPUTE_BUDGET_PROGRAM || price.accountKeyIndexes.length !== 0) {
    return refuse('its second instruction is not a compute unit price');
  }
  if (price.data.length !== 9 || price.data[0] !== SET_COMPUTE_UNIT_PRICE) {
    return refuse('its second instruction is not a compute unit price');
  }
  const microLamports = Buffer.from(price.data).readBigUInt64LE(1);
  if (microLamports > SVM_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS) {
    return refuse(`its compute unit price ${microLamports} is above the ceiling`);
  }

  if (program(transfer) !== TOKEN_PROGRAM) {
    return refuse('its third instruction is not an SPL token instruction');
  }
  if (transfer.data.length !== 10 || transfer.data[0] !== TRANSFER_CHECKED) {
    return refuse('its third instruction is not a TransferChecked');
  }
  const data = Buffer.from(transfer.data);
  if (data.readBigUInt64LE(1) !== option.amountAtomic) {
    return refuse('it transfers an amount other than the quoted one');
  }
  if (data[9] !== option.decimals) {
    return refuse('it transfers with decimals other than the quoted token has');
  }

  const accounts = Array.from(transfer.accountKeyIndexes, (index) => keys[index]);
  if (accounts.length !== 4) return refuse('its transfer names the wrong number of accounts');
  const [source, mint, destination, authority] = accounts;
  if (mint !== option.asset) return refuse('it transfers a mint other than the quoted one');
  if (authority !== payer) return refuse('the payer is not the transfer authority');
  if (source !== (await associatedTokenAddress(web3, payer, option.asset))) {
    return refuse("it spends from an account other than the payer's own token account");
  }
  if (destination !== (await associatedTokenAddress(web3, option.payTo, option.asset))) {
    return refuse("it pays an account other than the recipient's token account");
  }
}

interface RpcResult<T> {
  result?: T;
  error?: { message?: string };
}

/**
 * The latest blockhash, from a JSON-RPC endpoint.
 *
 * This is the one network call a Solana payment makes before it is sent, and it
 * runs after the gates: a transaction cannot be built without a recent hash, so
 * unlike an EIP-3009 authorization it cannot be signed offline. A failure here
 * is a network error, and nothing has been signed.
 */
export async function fetchLatestBlockhash(
  rpcUrl: string,
  timeoutMs = 15_000,
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  let body: RpcResult<{ value: { blockhash: string; lastValidBlockHeight: number } }>;
  try {
    const res = await request({
      url: rpcUrl,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'confirmed' }],
      }),
      timeoutMs,
    });
    body = JSON.parse(res.body) as typeof body;
  } catch (err) {
    throw new X402Error(
      ExitCode.GENERIC,
      `could not read a recent blockhash from ${rpcUrl}: ${(err as Error).message}. Nothing was signed.`,
    );
  }
  const value = body.result?.value;
  if (!value || typeof value.blockhash !== 'string') {
    throw new X402Error(
      ExitCode.GENERIC,
      `${rpcUrl} returned no blockhash${body.error?.message ? `: ${body.error.message}` : ''}. Nothing was signed.`,
    );
  }
  if (decodeBase58(value.blockhash).length !== 32) {
    throw new X402Error(ExitCode.GENERIC, `${rpcUrl} returned a malformed blockhash`);
  }
  return value;
}
