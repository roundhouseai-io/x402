import { X402Error, ExitCode } from './errors.js';

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/**
 * `90`, `90s`, `30m`, `2h` or `1500ms` as milliseconds.
 *
 * A bare number is seconds, which is what `--timeout` means everywhere else in
 * this CLI. Anything else is refused rather than guessed at: a wait that
 * silently becomes 30 milliseconds because `30 minutes` was typed with a space
 * would exit "timed out" before the first poll.
 */
export function parseDuration(input: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(input.trim());
  if (!match) {
    throw new X402Error(
      ExitCode.GENERIC,
      `cannot read "${input}" as a duration: use a number of seconds or 30s, 30m, 2h`,
    );
  }
  const unit = (match[2] ?? 's') as keyof typeof UNIT_MS;
  return Math.round(Number(match[1]) * UNIT_MS[unit]);
}

/** `1h 5m`, `4m 30s`, `45s`: for progress lines, not for parsing back. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}
