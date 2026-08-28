import { X402Error, ExitCode } from '../core/errors.js';
import { writeJson, isTty, writeErr } from '../core/output.js';
import { bool, str, type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';
import { findAsset, findChain, caip2 } from '../core/assets.js';
import { runSetup } from '../core/setup.js';

/** Wallet queries against the active signer backend, plus the guided setup. */
export async function walletCommand(parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0] ?? 'list';

  // `create` runs before the context is built on purpose: it is what you run
  // when there is no wallet yet, so resolving a signer first would fail.
  if (sub === 'create') return walletCreate(parsed);

  const ctx = buildContext(parsed);

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

  throw new X402Error(ExitCode.GENERIC, `usage: rh-x402 wallet <create|list|balance|address>`);
}

/** Guided setup: pick how the key is held, create the wallet, write config. */
async function walletCreate(parsed: ParsedArgs): Promise<number> {
  const result = await runSetup({
    ...pick('path', str(parsed.flags, 'path')),
    ...pick('name', str(parsed.flags, 'name')),
    ...pick('vaultPath', str(parsed.flags, 'vault')),
    ...pick('keyFile', str(parsed.flags, 'key-file')),
    ...pick('keystore', str(parsed.flags, 'keystore')),
    install: bool(parsed.flags, 'install') || bool(parsed.flags, 'install-global'),
    installGlobal: bool(parsed.flags, 'install-global'),
    replace: bool(parsed.flags, 'replace'),
  });

  if (isTty()) {
    process.stdout.write(
      `\nwallet "${result.wallet}" ready on the ${result.backend} backend\n` +
        `address ${result.address}\n\n`,
    );
    for (const [key, value] of Object.entries(result.configured)) {
      process.stdout.write(`  ${key} = ${value}\n`);
    }
    process.stdout.write('\nnext:\n');
    for (const step of result.nextSteps) process.stdout.write(`  - ${step}\n`);
  } else {
    writeJson({ ok: true, ...result });
  }

  // Said on every path, TTY or not: an address with no USDC pays for nothing,
  // and this is the step people skip.
  writeErr(`fund ${result.address} with USDC on Base before calling a paid endpoint`);
  return ExitCode.OK;
}

/** Omit an absent flag rather than passing `undefined` into an optional field. */
function pick<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}
