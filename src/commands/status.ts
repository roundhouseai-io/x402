import { ExitCode, X402Error } from '../core/errors.js';
import { writeJson } from '../core/output.js';
import { bool, str, type ParsedArgs } from '../core/args.js';
import { parseUnits } from '../core/assets.js';
import { collectStatus, DEFAULT_MIN_BALANCE, type Status } from '../core/status.js';

/** The table `status` prints by default: one `key  value` row per field. */
export function statusRows(s: Status): [string, string][] {
  const rows: [string, string][] = [
    ['cli.version', s.cli.version],
    ['node.version', s.node.version],
    ['node.ok', String(s.node.ok)],
    ['signer.path', s.signer.path],
    ['signer.backend', s.signer.backend ?? 'none'],
    ['signer.address', s.signer.address ?? 'null'],
    ['signer.typedData', String(s.signer.typedData)],
    ['signer.policy', s.signer.policy],
    ['balance.usdc', s.balance.usdc ?? 'null'],
    ['balance.chain', s.balance.chain],
    ['limits.maxPerCall', s.limits.maxPerCall],
    ['limits.dailyCap', s.limits.dailyCap],
    ['auth.apiKey', s.auth.apiKey],
    ['telemetry.enabled', String(s.telemetry.enabled)],
    ['spend.today', s.spend.today],
    ['spend.calls.today', String(s.spend.calls.today)],
    ['next', s.next],
  ];
  if (s.signer.error) rows.push(['signer.error', s.signer.error]);
  if (s.balance.error) rows.push(['balance.error', s.balance.error]);
  s.warnings.forEach((w, i) => rows.push([`warning.${i + 1}`, w]));
  return rows;
}

export function formatStatus(s: Status): string {
  const rows = statusRows(s);
  const width = Math.max(...rows.map(([k]) => k.length));
  return `${rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n')}\n`;
}

/**
 * Read-only: never pays, never signs, never prompts.
 *
 * Exit 0 only when `next` is `ready`, so a script can gate on it; any other
 * `next` exits 1 with the report still on stdout, since the report is the point.
 */
export async function statusCommand(parsed: ParsedArgs): Promise<number> {
  const minBalance = str(parsed.flags, 'min-balance') ?? DEFAULT_MIN_BALANCE;
  try {
    parseUnits(minBalance, 6);
  } catch {
    throw new X402Error(
      ExitCode.GENERIC,
      `--min-balance must be a decimal USDC amount, got ${minBalance}`,
    );
  }

  const status = await collectStatus({ minBalance });
  if (bool(parsed.flags, 'json')) writeJson(status);
  else process.stdout.write(formatStatus(status));
  return status.next === 'ready' ? ExitCode.OK : ExitCode.GENERIC;
}
