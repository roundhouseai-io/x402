import { ExitCode, X402Error } from '../core/errors.js';
import { formatUnits } from '../core/assets.js';
import { listChannels } from '../core/channelstore.js';
import { writeJson, isTty } from '../core/output.js';
import { str, type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';

/**
 * `rh-x402 channel list` and `rh-x402 channel refund <url>`.
 *
 * A payment channel holds money in escrow between calls, so it has to be
 * visible: `list` says what is deposited, what has been charged and what could
 * come back, and `refund` asks the receiver to send the rest back.
 */
export async function channelCommand(parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'list' || sub === undefined) return channelList();
  if (sub === 'refund') return channelRefund(parsed);
  throw new X402Error(
    ExitCode.GENERIC,
    'usage: rh-x402 channel <list|refund <url> [--amount <n>]>',
  );
}

function channelList(): number {
  const rows = listChannels().map((c) => {
    const balance = BigInt(c.balance);
    const charged = BigInt(c.charged);
    const refundable = balance > charged ? balance - charged : 0n;
    return {
      channelId: c.channelId,
      wallet: c.wallet,
      chain: c.chain,
      network: c.network,
      payTo: c.config.receiver,
      receiver: c.config.receiver,
      asset: c.asset,
      assetSymbol: c.assetSymbol,
      deposited: formatUnits(balance, c.decimals),
      balance: formatUnits(balance, c.decimals),
      spent: formatUnits(charged, c.decimals),
      charged: formatUnits(charged, c.decimals),
      remaining: formatUnits(refundable, c.decimals),
      refundable: formatUnits(refundable, c.decimals),
      highestVoucher: formatUnits(BigInt(c.signedMax), c.decimals),
      ...(c.pendingDeposit
        ? {
            pendingDeposit: formatUnits(BigInt(c.pendingDeposit.amount), c.decimals),
            pendingUntil: new Date(c.pendingDeposit.until * 1000).toISOString(),
          }
        : {}),
      lastUrl: c.url,
      updatedAt: c.updatedAt,
    };
  });
  if (isTty()) {
    if (rows.length === 0) process.stdout.write('no payment channels\n');
    for (const r of rows) {
      process.stdout.write(
        `${r.channelId.slice(0, 12)}…  ${r.deposited} ${r.assetSymbol} deposited, ${r.spent} spent, ` +
          `${r.remaining} remaining  ${r.payTo} on ${r.network}${r.pendingDeposit ? `  (deposit of ${r.pendingDeposit} unconfirmed until ${r.pendingUntil})` : ''}\n`,
      );
    }
  } else {
    writeJson({ ok: true, channels: rows });
  }
  return ExitCode.OK;
}

async function channelRefund(parsed: ParsedArgs): Promise<number> {
  const target = parsed.positionals[1];
  if (!target) {
    throw new X402Error(
      ExitCode.GENERIC,
      'usage: rh-x402 channel refund <url> [--amount <n>] [--method GET|POST]',
    );
  }
  const ctx = buildContext(parsed);
  const result = await ctx.engine.refundChannel({
    target,
    amount: str(parsed.flags, 'amount'),
    method: str(parsed.flags, 'method'),
    wallet: ctx.walletName,
    signer: ctx.backendName,
  });
  await ctx.sink.flush();
  if (isTty()) {
    process.stdout.write(
      result.ok
        ? `refund accepted${result.refunded ? `: ${result.refunded} ${result.asset ?? ''}` : ''}; ${result.remaining ?? '0'} still refundable\n`
        : `refund failed: ${result.error ?? 'unknown error'}\n`,
    );
  } else {
    writeJson(result);
  }
  return result.ok ? ExitCode.OK : (result.errorCode ?? ExitCode.GENERIC);
}
