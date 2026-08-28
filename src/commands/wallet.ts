import { X402Error, ExitCode } from '../core/errors.js';
import { writeJson, isTty, writeErr } from '../core/output.js';
import { bool, str, list, type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';
import { findAsset, findChain, caip2 } from '../core/assets.js';
import { runSetup, writeConfig, unsetConfig, type ConfigValue } from '../core/setup.js';
import { grantPolicyKey } from '../core/owspolicy.js';

/** Wallet queries against the active signer backend, plus the guided setup. */
export async function walletCommand(parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0] ?? 'list';

  // `create` runs before the context is built on purpose: it is what you run
  // when there is no wallet yet, so resolving a signer first would fail.
  if (sub === 'create') return walletCreate(parsed);
  if (sub === 'policy') return walletPolicy(parsed);
  if (sub === 'forget' || sub === 'restore') return walletVisibility(parsed, sub);

  const ctx = buildContext(parsed);

  if (sub === 'list') {
    const signer = await ctx.signer();
    const all = await signer.getAccounts();
    // Hidden wallets are filtered here, never removed from the backend. The
    // count is still reported so a hidden wallet is not silently invisible.
    const hidden = ctx.config.wallet.hidden ?? [];
    const accounts = all.filter((a) => !hidden.includes(a.id));
    const hiddenCount = all.length - accounts.length;
    if (isTty()) {
      if (accounts.length === 0) process.stdout.write('no wallets\n');
      for (const a of accounts) {
        const mark = a.id === ctx.walletName ? '*' : ' ';
        process.stdout.write(`${mark} ${a.id}  ${a.address}\n`);
      }
      if (hiddenCount > 0) {
        process.stdout.write(
          `${hiddenCount} hidden (still in the backend; \`rh-x402 wallet restore <name>\`)\n`,
        );
      }
    } else {
      writeJson({
        ok: true,
        backend: signer.backend,
        default: ctx.walletName ?? null,
        wallets: accounts,
        hidden,
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

  throw new X402Error(
    ExitCode.GENERIC,
    `usage: rh-x402 wallet <create|policy|list|balance|address>`,
  );
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
    // Only force the answer when the caller said something. Left alone, the
    // guided path asks and the non-interactive path defaults to no policy
    // rather than minting a key nobody asked for.
    ...(bool(parsed.flags, 'policy') ? { policy: true } : {}),
    ...(bool(parsed.flags, 'no-policy') ? { policy: false } : {}),
    ...(list(parsed.flags, 'chain').length > 0 ? { chains: list(parsed.flags, 'chain') } : {}),
    ...(str(parsed.flags, 'expires') ? { expires: str(parsed.flags, 'expires')! } : {}),
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
    if (result.policy) {
      process.stdout.write(`\nexport OWS_X402_KEY=${result.policy.token}\n`);
    }
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

/**
 * Put an OWS policy in front of this wallet, and switch the backend to signing
 * with the API key that carries it.
 *
 * This is the difference between a spend control this CLI promises and one OWS
 * enforces: with a passphrase the backend is owner access and can sign
 * anything; with the key, OWS refuses a contract or chain outside the policy
 * before the key is ever decrypted.
 */
async function walletPolicy(parsed: ParsedArgs): Promise<number> {
  const ctx = buildContext(parsed);
  if (ctx.backendName !== 'ows-core') {
    throw new X402Error(
      ExitCode.GENERIC,
      `policies are an OWS feature and the active backend is "${ctx.backendName}". ` +
        'Run `rh-x402 wallet create --path ows` first.',
    );
  }
  const wallet = ctx.walletName;
  if (!wallet) {
    throw new X402Error(
      ExitCode.GENERIC,
      'no wallet selected: pass --wallet or set wallet.default',
    );
  }

  const core = ctx.config.wallet.backends['ows-core'] ?? {};
  const chains = list(parsed.flags, 'chain');
  const grant = await grantPolicyKey({
    wallet,
    chains: chains.length > 0 ? chains : [ctx.config.defaults.chain],
    ...(str(parsed.flags, 'expires') ? { expires: str(parsed.flags, 'expires')! } : {}),
    ...(core.vaultPath ? { vaultPath: core.vaultPath } : {}),
    ...(core.passphrase ? { passphrase: core.passphrase } : {}),
  });

  // The token is a secret, so it follows the same rule as every other secret
  // here: config stores an `env:` indirection and never the value. OWS shows
  // the token once and cannot show it again, so it is printed and not kept.
  writeConfig({
    'wallet.backends.ows-core.apiKey': 'env:OWS_X402_KEY',
    'wallet.backends.ows-core.requireApiKey': true,
  });

  if (isTty()) {
    process.stdout.write(
      `\npolicy ${grant.policy.id} registered, api key ${grant.keyId} bound to it\n` +
        `${grant.policy.rules.map((r) => `  - ${JSON.stringify(r)}`).join('\n')}\n\n` +
        `export OWS_X402_KEY=${grant.token}\n\n`,
    );
  } else {
    writeJson({ ok: true, policy: grant.policy, keyId: grant.keyId, token: grant.token });
  }

  writeErr(
    'save that token now — OWS shows it once and cannot show it again. Export it as ' +
      'OWS_X402_KEY in every shell that will pay; without it the backend falls back to ' +
      'the vault passphrase, which is owner access and gated by nothing.',
  );
  writeErr(
    'this policy bounds WHAT may be signed (chain, token contract, expiry). OWS has no ' +
      'amount rule, so limits.maxPerCall is still the only cap on HOW MUCH, and it is ' +
      'still advisory.',
  );
  return ExitCode.OK;
}

/**
 * Hide a wallet from this CLI, or bring it back.
 *
 * Deliberately not a delete. `@open-wallet-standard/core` exposes
 * `deleteWallet`, and this package never calls it: a wallet holds money, and
 * "remove it from my tooling" must never quietly mean "destroy it". Forgetting
 * writes a name to `wallet.hidden` and clears `wallet.default` if it pointed
 * there. The vault is untouched, and `ows wallet list` still shows it.
 */
async function walletVisibility(parsed: ParsedArgs, sub: 'forget' | 'restore'): Promise<number> {
  const ctx = buildContext(parsed);
  const name = parsed.positionals[1];
  if (!name) {
    throw new X402Error(ExitCode.GENERIC, `usage: rh-x402 wallet ${sub} <name>`);
  }

  const hidden = new Set(ctx.config.wallet.hidden ?? []);
  if (sub === 'forget') hidden.add(name);
  else hidden.delete(name);

  const entries: Record<string, ConfigValue> = { 'wallet.hidden': [...hidden] };
  // A hidden wallet must not stay the default, or every later command resolves
  // to something this CLI is pretending not to see.
  const clearedDefault = sub === 'forget' && ctx.config.wallet.default === name;
  writeConfig(entries);
  if (clearedDefault) unsetConfig('wallet.default');

  const note =
    sub === 'forget'
      ? `"${name}" is hidden from rh-x402. It still exists in the backend with its funds ` +
        'intact — this changed local config only. Bring it back with ' +
        `\`rh-x402 wallet restore ${name}\`.`
      : `"${name}" is visible again.`;

  if (isTty()) process.stdout.write(`${note}\n`);
  else {
    writeJson({
      ok: true,
      wallet: name,
      hidden: [...hidden],
      clearedDefault,
      backendUnchanged: true,
      note,
    });
  }
  return ExitCode.OK;
}
