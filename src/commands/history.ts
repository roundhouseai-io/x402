import { ExitCode, X402Error } from '../core/errors.js';
import {
  readRecords,
  queryRecords,
  sumRecords,
  GROUP_KEYS,
  isGroupKey,
  type GroupKey,
} from '../core/ledger.js';
import { writeJson, isTty } from '../core/output.js';
import { bool, num, str, type ParsedArgs } from '../core/args.js';

export function historyCommand(parsed: ParsedArgs): number {
  const records = queryRecords(readRecords(), {
    since: str(parsed.flags, 'since'),
    until: str(parsed.flags, 'until'),
    paidOnly: bool(parsed.flags, 'paid-only'),
    limit: num(parsed.flags, 'limit'),
    wallet: str(parsed.flags, 'wallet'),
    url: parsed.positionals[0],
  });

  const byRaw = str(parsed.flags, 'by');
  let by: GroupKey | undefined;
  if (byRaw) {
    if (!isGroupKey(byRaw)) {
      throw new X402Error(ExitCode.GENERIC, `--by must be one of ${GROUP_KEYS.join('|')}`);
    }
    by = byRaw;
  }

  if (bool(parsed.flags, 'sum') || by) {
    const rows = sumRecords(records, by);
    if (isTty()) {
      if (rows.length === 0) process.stdout.write('no matching records\n');
      for (const row of rows) {
        process.stdout.write(
          `${row.total.padStart(12)} ${row.asset.padEnd(6)} ${String(row.paidCalls).padStart(5)} paid / ${String(
            row.calls,
          ).padStart(5)} calls  ${by ? row.key : ''}\n`,
        );
      }
    } else {
      writeJson({ ok: true, groupedBy: by ?? null, rows });
    }
    return ExitCode.OK;
  }

  if (isTty()) {
    if (records.length === 0) process.stdout.write('no matching records\n');
    for (const r of records) {
      const paid = r.payment.paid ? `${r.payment.amount} ${r.payment.asset ?? ''}` : 'free';
      process.stdout.write(
        `${r.ts}  ${String(r.response.status ?? '-').padStart(3)}  ${paid.padEnd(14)} ${r.method} ${r.url}\n`,
      );
    }
  } else {
    writeJson({ ok: true, count: records.length, records });
  }
  return ExitCode.OK;
}
