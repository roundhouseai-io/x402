import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  openSync,
  closeSync,
  writeSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureDir, paths, writePrivate } from './paths.js';
import { sha256 } from './ids.js';
import { ExitCode, X402Error } from './errors.js';
import type { ChannelConfig, ChannelState } from './channel.js';

/**
 * Where the client remembers its payment channels: one JSON file per channel
 * under ~/.x402/channels, 0600 in a 0700 directory, like every other state file.
 *
 * A channel is found by its *slot*, the wallet, backend, chain, receiver, token
 * and receiver authorizer. The slot is known before the signer is asked for an
 * address, which is what lets the gates run first. The channel id, which needs
 * the payer's address, is stored inside.
 */

export interface ChannelRecord extends ChannelState {
  version: 1;
  slot: string;
  channelId: string;
  config: ChannelConfig;
  network: string;
  chain: string;
  wallet: string;
  backend: string;
  /** Where it was used last, for `channel list`. */
  url: string;
  asset: string;
  assetSymbol: string;
  decimals: number;
  /** The last voucher signed, kept so a refund can name the amount charged. */
  voucherSignature?: string;
  /**
   * A deposit that was signed and sent but not confirmed. The receiver can submit
   * it until `until` (unix seconds), so no second deposit is signed before then.
   */
  pendingDeposit?: { amount: string; until: number };
  createdAt: string;
  updatedAt: string;
}

export interface SlotInput {
  wallet: string;
  backend: string;
  chain: string;
  payTo: string;
  asset: string;
  receiverAuthorizer: string;
  salt?: string;
}

/** Case is not significant in an EVM address, so it is not part of the slot. */
export function slotKey(s: SlotInput): string {
  return sha256(
    [
      s.backend,
      s.wallet,
      s.chain,
      s.payTo.toLowerCase(),
      s.asset.toLowerCase(),
      s.receiverAuthorizer.toLowerCase(),
      s.salt ?? '0',
    ].join('|'),
  );
}

const file = (slot: string) => join(paths.channels(), `${slot}.json`);

export function readChannel(slot: string): ChannelRecord | undefined {
  const f = file(slot);
  if (!existsSync(f)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as ChannelRecord;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeChannel(record: ChannelRecord): void {
  writePrivate(file(record.slot), `${JSON.stringify(record, null, 2)}\n`);
}

export function deleteChannel(slot: string): void {
  const f = file(slot);
  if (existsSync(f)) unlinkSync(f);
}

export function listChannels(): ChannelRecord[] {
  const dir = paths.channels();
  if (!existsSync(dir)) return [];
  const out: ChannelRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const rec = readChannel(name.slice(0, -'.json'.length));
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Find a channel by its id or an unambiguous prefix of it. */
export function findChannelById(idOrPrefix: string): ChannelRecord | undefined {
  const want = idOrPrefix.toLowerCase();
  const hits = listChannels().filter((c) => c.channelId.toLowerCase().startsWith(want));
  return hits.length === 1 ? hits[0] : undefined;
}

/* ---------------------------------------------------------------------------
   One signer at a time per channel.

   A voucher names a cumulative amount, so two vouchers signed from the same
   starting state would both name the same number. A lock file held from the
   moment the voucher is planned until the response has been recorded keeps two
   calls, in this process or another, from signing from the same state.
--------------------------------------------------------------------------- */

/**
 * A lock older than this was left by a process that died, and is taken over. Long,
 * because a streamed call can legitimately hold a channel for minutes, and taking
 * a live call's lock would let two vouchers be signed from the same state.
 */
const STALE_LOCK_MS = 600_000;
const LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 100;

export async function lockChannel(
  slot: string,
  waitMs: number = LOCK_WAIT_MS,
): Promise<() => void> {
  const now = Date.now;
  const dir = ensureDir(join(paths.channels(), 'locks'));
  const lock = join(dir, `${slot}.lock`);
  const deadline = now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600);
      writeSync(fd, `${String(process.pid)} ${new Date(now()).toISOString()}\n`);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // released between the open and the stat
      }
      if (now() >= deadline) {
        throw new X402Error(
          ExitCode.GENERIC,
          'another call is using this payment channel. Nothing was signed; try again when it finishes.',
        );
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
}
