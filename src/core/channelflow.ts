import { ExitCode, X402Error } from './errors.js';
import { ethCall } from './rpc.js';
import { selector } from './keccak.js';
import {
  BATCH_SETTLEMENT_ADDRESS,
  BATCH_SETTLEMENT_SCHEME,
  CUMULATIVE_BELOW_CLAIMED,
  CUMULATIVE_MISMATCH,
  applyCharge,
  chargeReport,
  correctiveCharged,
  repairFromCorrective,
  type ChannelConfig,
} from './channel.js';
import { readChannel, slotKey, writeChannel, type ChannelRecord } from './channelstore.js';
import type { PaymentOption } from './x402.js';
import type { SettlementResponse } from './eip3009.js';

/**
 * The channel bookkeeping around a call: finding the channel, believing the chain
 * about it, and updating it from what the receiver says. The engine does the
 * signing and the HTTP; everything that decides what to remember lives here so
 * it can be tested without either.
 */

const extraOf = (option: PaymentOption): Record<string, unknown> => {
  const e = option.raw.extra;
  return typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {};
};

/** The slot a quote and a wallet map to. Known before the signer is asked for an address. */
export function slotFor(
  option: PaymentOption,
  wallet: string,
  backend: string,
  salt: string,
): string {
  const ra = extraOf(option).receiverAuthorizer;
  return slotKey({
    wallet,
    backend,
    chain: option.chain,
    payTo: option.payTo,
    asset: option.asset,
    receiverAuthorizer: typeof ra === 'string' ? ra : '0x',
    salt,
  });
}

/** What the escrow contract holds for a channel. */
export interface OnChainChannel {
  balance: bigint;
  totalClaimed: bigint;
}

const CHANNELS_SELECTOR = selector('channels(bytes32)');

export type ChannelReader = (channelId: string) => Promise<OnChainChannel>;

/** `channels(bytes32)` on the escrow: (balance, totalClaimed), two uint128 words. */
export function onChainReader(rpcUrl: string): ChannelReader {
  return async (channelId) => {
    const hex = await ethCall(
      rpcUrl,
      BATCH_SETTLEMENT_ADDRESS,
      `${CHANNELS_SELECTOR}${channelId.slice(2)}`,
    );
    if (!/^0x[0-9a-fA-F]{128,}$/.test(hex)) {
      throw new X402Error(
        ExitCode.GENERIC,
        `the escrow returned an unreadable channel (${hex || 'empty'}). Nothing was signed.`,
      );
    }
    return {
      balance: BigInt(`0x${hex.slice(2, 66)}`),
      totalClaimed: BigInt(`0x${hex.slice(66, 130)}`),
    };
  };
}

export interface PrepareInput {
  slot: string;
  config: ChannelConfig;
  channelId: string;
  option: PaymentOption;
  wallet: string;
  backend: string;
  url: string;
  /** Unix seconds. */
  nowSeconds: number;
  /** Absent when no RPC endpoint is configured. */
  read: ChannelReader | undefined;
}

/**
 * The channel to plan against. A channel this client already knows is used as
 * recorded. One it does not know is looked up on-chain, so that a lost state file
 * does not turn into a second deposit; one with a deposit still in flight is not
 * touched until that deposit can no longer land.
 *
 * Fails closed: if the answer would be a guess about money, nothing is signed.
 */
export async function prepareChannel(input: PrepareInput): Promise<ChannelRecord | undefined> {
  let rec = readChannel(input.slot);
  const pending = rec?.pendingDeposit;

  if (pending && input.nowSeconds < pending.until) {
    throw new X402Error(
      ExitCode.GENERIC,
      `a deposit of ${pending.amount} atomic units into this channel was signed and may still be submitted until ` +
        `${new Date(pending.until * 1000).toISOString()}. Nothing was signed; wait until then, or check the channel on-chain.`,
    );
  }
  if (rec && !pending) return rec;

  if (!input.read) {
    if (pending) {
      throw new X402Error(
        ExitCode.GENERIC,
        'a previous deposit was never confirmed and there is no RPC endpoint to check it. Set one with `rh-x402 config set rpc.<chain> <url>`. Nothing was signed.',
      );
    }
    return undefined;
  }

  let onChain: OnChainChannel;
  try {
    onChain = await input.read(input.channelId);
  } catch (err) {
    if (err instanceof X402Error) throw err;
    throw new X402Error(
      ExitCode.GENERIC,
      `could not read the channel on-chain: ${(err as Error).message}. Nothing was signed.`,
    );
  }

  if (onChain.balance === 0n && onChain.totalClaimed === 0n) {
    // Nothing there. An unconfirmed deposit that never landed is forgotten.
    if (rec && pending) {
      const { pendingDeposit: _gone, ...rest } = rec;
      rec = rest;
      writeChannel(rec);
    }
    return rec;
  }

  const now = new Date(input.nowSeconds * 1000).toISOString();
  const adopted: ChannelRecord = {
    ...(rec ?? {
      version: 1 as const,
      slot: input.slot,
      channelId: input.channelId,
      config: input.config,
      network: input.option.network,
      chain: input.option.chain,
      wallet: input.wallet,
      backend: input.backend,
      url: input.url,
      asset: input.option.asset,
      assetSymbol: input.option.assetSymbol,
      decimals: input.option.decimals,
      createdAt: now,
    }),
    // The chain's figures stand in for what was lost. totalClaimed can lag what the
    // receiver holds off-chain, which a corrective 402 reports; see docs.
    balance: onChain.balance.toString(),
    charged: onChain.totalClaimed.toString(),
    signedMax: onChain.totalClaimed.toString(),
    updatedAt: now,
  };
  delete adopted.pendingDeposit;
  writeChannel(adopted);
  return adopted;
}

export interface Voucher {
  maxClaimable: bigint;
  signature: string;
}

/** Remember what was signed before it is sent, so a crash cannot lose the highest voucher. */
export function recordSigned(
  existing: ChannelRecord | undefined,
  base: Omit<
    ChannelRecord,
    | 'balance'
    | 'charged'
    | 'signedMax'
    | 'updatedAt'
    | 'createdAt'
    | 'voucherSignature'
    | 'pendingDeposit'
  >,
  voucher: Voucher,
  deposit: { amount: bigint; until: number } | undefined,
  nowIso: string,
): ChannelRecord {
  const prevSigned = BigInt(existing?.signedMax ?? '0');
  const rec: ChannelRecord = {
    ...base,
    balance: existing?.balance ?? '0',
    charged: existing?.charged ?? '0',
    // Never lowered: the highest cumulative amount ever signed bounds what the
    // receiver can claim, and what a corrective 402 can be believed up to.
    signedMax: (voucher.maxClaimable > prevSigned ? voucher.maxClaimable : prevSigned).toString(),
    voucherSignature: voucher.signature,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    ...(deposit
      ? { pendingDeposit: { amount: deposit.amount.toString(), until: deposit.until } }
      : {}),
  };
  writeChannel(rec);
  return rec;
}

export interface SentChannelPayload {
  kind: 'voucher' | 'deposit';
  channelId: string;
  maxClaimable: bigint;
  deposit: bigint | undefined;
  request: bigint;
  /** Unix seconds after which a deposit authorization can no longer be submitted. */
  depositUntil: number | undefined;
}

export interface ChannelOutcome {
  /** New money that left the wallet on this call: the deposit, or nothing for a voucher. */
  exposure: bigint;
  /** What this request was charged against the channel, when the receiver said. */
  charged: bigint | undefined;
  confirmed: boolean;
  record: ChannelRecord | undefined;
}

/**
 * Update the channel after the paid request came back.
 *
 * Only a receipt that says the settlement succeeded changes the balance and the
 * charged total. Without one the charge is unknown and is left alone, and a
 * deposit stays pending: it may still land, so it is neither counted as lost nor
 * counted twice. The daily cap counts a deposit as spent either way.
 */
export function recordChannelResponse(
  slot: string,
  sent: SentChannelPayload,
  settlement: SettlementResponse | undefined,
  httpOk: boolean,
  nowIso: string,
): ChannelOutcome {
  const rec = readChannel(slot);
  const exposure = sent.deposit ?? 0n;
  if (!rec) return { exposure, charged: undefined, confirmed: false, record: undefined };

  const confirmed = settlement?.success === true && httpOk;
  if (!confirmed) {
    // Keep the pending marker written when the voucher was signed.
    return { exposure, charged: undefined, confirmed: false, record: rec };
  }
  const report = chargeReport(settlement as Record<string, unknown>);
  const next = applyCharge(rec, report, sent.request, sent.deposit, sent.maxClaimable);
  const updated: ChannelRecord = { ...rec, ...next, updatedAt: nowIso };
  delete updated.pendingDeposit;
  writeChannel(updated);
  return { exposure, charged: report.charged, confirmed: true, record: updated };
}

/**
 * A 402 after paying a voucher can be the receiver saying "my total is not yours".
 * If it names a cumulative figure inside what this client has signed for, adopt it
 * so the next voucher is built on it. Returns whether the state was repaired.
 */
export function repairFromPaymentRequired(slot: string, raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const body = raw as Record<string, unknown>;
  if (body.error !== CUMULATIVE_MISMATCH && body.error !== CUMULATIVE_BELOW_CLAIMED) return false;
  const claimed = correctiveCharged(body.accepts);
  const rec = readChannel(slot);
  if (claimed === undefined || !rec) return false;
  const repaired = repairFromCorrective(rec, claimed);
  if (!repaired) return false;
  writeChannel({ ...rec, ...repaired, updatedAt: new Date().toISOString() });
  return true;
}

export { BATCH_SETTLEMENT_SCHEME };
