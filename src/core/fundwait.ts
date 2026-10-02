import { messageOf } from './errors.js';
import { formatDuration } from './duration.js';

/**
 * Poll a balance until it reaches a floor or time runs out.
 *
 * The reading is injected, so the loop is the same for `wallet balance --wait`
 * and for the funding step of `setup`, and a test can drive it without a clock
 * or a network.
 *
 * A failed reading does not end the wait. A public RPC rate-limits, and one
 * refused request is not evidence the wallet is empty or the operator has
 * stopped: the loop keeps polling and reports the last error only if time runs
 * out with nothing to show for it.
 */

export interface BalanceReading {
  /** Decimal, e.g. `0.978`. */
  amount: string;
  atomic: bigint;
}

export interface WaitOptions {
  read: () => Promise<BalanceReading>;
  minAtomic: bigint;
  /** What the floor is, for the progress line: `1.00 USDC on base`. */
  label: string;
  timeoutMs: number;
  intervalMs?: number;
  /** At most one progress line per this long. Defaults to a minute. */
  progressEveryMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (line: string) => void;
}

export interface WaitResult {
  met: boolean;
  /** The last balance read, or null if no read ever succeeded. */
  amount: string | null;
  polls: number;
  elapsedMs: number;
  /** The last read error, kept even after a later read succeeds. */
  lastError?: string;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function waitForBalance(opts: WaitOptions): Promise<WaitResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const interval = opts.intervalMs ?? 10_000;
  const every = opts.progressEveryMs ?? 60_000;
  const started = now();
  let lastProgress = Number.NEGATIVE_INFINITY;
  let amount: string | null = null;
  let lastError: string | undefined;
  let polls = 0;

  for (;;) {
    polls++;
    try {
      const reading = await opts.read();
      amount = reading.amount;
      if (reading.atomic >= opts.minAtomic) {
        return {
          met: true,
          amount,
          polls,
          elapsedMs: now() - started,
          ...(lastError ? { lastError } : {}),
        };
      }
    } catch (err) {
      lastError = messageOf(err);
    }

    const elapsed = now() - started;
    if (elapsed >= opts.timeoutMs) {
      return { met: false, amount, polls, elapsedMs: elapsed, ...(lastError ? { lastError } : {}) };
    }

    if (now() - lastProgress >= every) {
      lastProgress = now();
      const have = amount === null ? 'balance not readable yet' : `balance ${amount}`;
      opts.onProgress?.(
        `waiting for ${opts.label} (${have}, ${formatDuration(elapsed)} elapsed, ` +
          `times out in ${formatDuration(opts.timeoutMs - elapsed)})`,
      );
    }

    await sleep(Math.min(interval, Math.max(0, opts.timeoutMs - elapsed)));
  }
}
