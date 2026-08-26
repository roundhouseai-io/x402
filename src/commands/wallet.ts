import { X402Error, ExitCode } from '../core/errors.js';
import { writeJson, isTty } from '../core/output.js';
import { str, type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';
import { findAsset } from '../core/assets.js';
import { findChain, caip2 } from '../core/assets.js';

/** Passthrough to OWS: list wallets, show an address, read a balance. */
export async function walletCommand(parsed: ParsedArgs): Promise<number> {
  const ctx = buildContext(parsed);
  const sub = parsed.positionals[0] ?? 'list';

  if (sub === 'list') {
    const wallets = await ctx.ows.listWallets();
    if (isTty()) {
      if (wallets.length === 0) process.stdout.write('no wallets\n');
      for (const w of wallets) {
        const mark = w.name === ctx.walletName || w.id === ctx.walletName ? '*' : ' ';
        process.stdout.write(`${mark} ${w.name ?? w.id}  ${w.address}\n`);
      }
    } else {
      writeJson({ ok: true, default: ctx.walletName, wallets });
    }
    return ExitCode.OK;
  }

  if (sub === 'address') {
    const signer = await ctx.signer();
    const address = await signer.address();
    if (isTty()) process.stdout.write(`${address}\n`);
    else writeJson({ ok: true, wallet: signer.wallet, address });
    return ExitCode.OK;
  }

  if (sub === 'balance') {
    if (!ctx.walletName) {
      throw new X402Error(ExitCode.OWS_UNREACHABLE, 'no wallet selected: pass --wallet');
    }
    const chainName = str(parsed.flags, 'chain') ?? ctx.config.defaults.chain;
    const chain = findChain(chainName);
    if (!chain) throw new X402Error(ExitCode.GENERIC, `unknown chain: ${chainName}`);
    const asset = findAsset(parsed.positionals[1] ?? 'usdc', chain.chainId);
    if (!asset) {
      throw new X402Error(
        ExitCode.GENERIC,
        `unknown asset on ${chain.network}: ${parsed.positionals[1]}`,
      );
    }
    const balance = await ctx.ows.balance(ctx.walletName, asset.address, caip2(chain.chainId));
    if (isTty()) {
      process.stdout.write(`${balance?.amount ?? 'unknown'} ${asset.symbol} on ${chain.network}\n`);
    } else {
      writeJson({
        ok: balance !== undefined,
        wallet: ctx.walletName,
        asset: asset.symbol,
        chain: caip2(chain.chainId),
        amount: balance?.amount,
      });
    }
    return balance ? ExitCode.OK : ExitCode.GENERIC;
  }

  throw new X402Error(ExitCode.GENERIC, `usage: x402 wallet <list|balance|address>`);
}
