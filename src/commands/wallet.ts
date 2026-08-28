import { X402Error, ExitCode } from '../core/errors.js';
import { writeJson, isTty } from '../core/output.js';
import { str, type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';
import { findAsset, findChain, caip2 } from '../core/assets.js';

/** Wallet queries against the active signer backend. */
export async function walletCommand(parsed: ParsedArgs): Promise<number> {
  const ctx = buildContext(parsed);
  const sub = parsed.positionals[0] ?? 'list';

  if (sub === 'list') {
    const signer = await ctx.signer();
    const accounts = await signer.getAccounts();
    if (isTty()) {
      if (accounts.length === 0) process.stdout.write('no wallets\n');
      for (const a of accounts) {
        const mark = a.id === ctx.walletName ? '*' : ' ';
        process.stdout.write(`${mark} ${a.id}  ${a.address}\n`);
      }
    } else {
      writeJson({
        ok: true,
        backend: signer.backend,
        default: ctx.walletName ?? null,
        wallets: accounts,
      });
    }
    return ExitCode.OK;
  }

  if (sub === 'address') {
    const signer = await ctx.signer();
    const address = await signer.getAddress();
    if (isTty()) process.stdout.write(`${address}\n`);
    else writeJson({ ok: true, backend: signer.backend, wallet: signer.wallet, address });
    return ExitCode.OK;
  }

  if (sub === 'balance') {
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

    const signer = await ctx.signer();
    if (!signer.getBalance) {
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        `the ${signer.backend} backend cannot report balances`,
      );
    }
    const balance = await signer.getBalance(asset.address, caip2(chain.chainId));
    if (isTty()) {
      process.stdout.write(`${balance?.amount ?? 'unknown'} ${asset.symbol} on ${chain.network}\n`);
    } else {
      writeJson({
        ok: balance !== undefined,
        backend: signer.backend,
        wallet: signer.wallet,
        asset: asset.symbol,
        chain: caip2(chain.chainId),
        amount: balance?.amount ?? null,
      });
    }
    return balance ? ExitCode.OK : ExitCode.GENERIC;
  }

  throw new X402Error(ExitCode.GENERIC, `usage: rh-x402 wallet <list|balance|address>`);
}
