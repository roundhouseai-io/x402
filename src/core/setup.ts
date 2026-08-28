import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { X402Error, ExitCode } from './errors.js';
import { readRawConfig, writeRawConfig, setPath } from './config.js';
import { addEntry, generatePrivateKey, readKeyFile, keystorePath } from './keystore.js';
import { loadEthers } from './signers/local.js';
import { loadOwsCore, type OwsCoreModule, type OwsWallet } from './signers/owscore.js';
import { ask, confirm, interactive, secretTwice, select } from './prompt.js';

/**
 * The guided wallet setup behind `rh-x402 wallet create`.
 *
 * Everything here is a one-off configuration step, never part of the payment
 * loop. It is written so the same work can be done with flags and no terminal:
 * an agent that cannot answer a prompt gets a clear exit rather than a hang.
 */

/** The three ways to hold a key, in the order they should be preferred. */
export const KEY_PATHS = ['ows', 'import', 'generate'] as const;
export type KeyPath = (typeof KEY_PATHS)[number];

export const OWS_PACKAGE = '@open-wallet-standard/core';

export interface SetupOptions {
  path?: string;
  name?: string;
  vaultPath?: string;
  keyFile?: string;
  keystore?: string;
  /** Permit running the package manager. Never implied. */
  install?: boolean;
  /** Install globally too, so the `ows` CLI lands on PATH. */
  installGlobal?: boolean;
  replace?: boolean;
}

export interface SetupResult {
  path: KeyPath;
  backend: string;
  wallet: string;
  address: string;
  /** Dotted config keys this wrote, so the caller can show its work. */
  configured: Record<string, string>;
  /** Things the operator still has to do; never empty for a funded wallet. */
  nextSteps: string[];
  installed?: string;
}

function isKeyPath(value: string): value is KeyPath {
  // SAFETY: widening the literal tuple to string[] only to ask whether it
  // contains `value`; the predicate is what narrows, and `includes` is the check.
  return (KEY_PATHS as readonly string[]).includes(value);
}

/** Config is written key by key, the same way `config set` writes it. */
function writeConfig(entries: Record<string, string>): void {
  let raw = readRawConfig();
  for (const [key, value] of Object.entries(entries)) {
    raw = setPath(raw, key, value);
  }
  writeRawConfig(raw);
}

async function choosePath(opts: SetupOptions): Promise<KeyPath> {
  if (opts.path !== undefined) {
    if (!isKeyPath(opts.path)) {
      throw new X402Error(
        ExitCode.GENERIC,
        `unknown --path ${opts.path}: expected one of ${KEY_PATHS.join(', ')}`,
      );
    }
    return opts.path;
  }
  if (!interactive()) {
    throw new X402Error(
      ExitCode.GENERIC,
      `no terminal attached: pass --path <${KEY_PATHS.join('|')}> to choose without prompting`,
    );
  }
  return select<KeyPath>(
    'How should this wallet hold its key?',
    [
      {
        value: 'ows',
        label: 'Open Wallet Standard  (recommended)',
        detail: 'The key stays encrypted in the OWS vault and is never handed to this CLI.',
      },
      {
        value: 'import',
        label: 'Import a private key you already have',
        detail: 'Read from a key file into an encrypted keystore. Development and CI.',
      },
      {
        value: 'generate',
        label: 'Generate a key here  (not recommended)',
        detail: 'Same keystore, but the key is made by this tool. Throwaway wallets only.',
      },
    ],
    0,
  );
}

/**
 * The `node_modules` that owns this package, or undefined when running from a
 * source checkout.
 *
 * This is the whole reason the install is not a plain `npm i`. `loadOwsCore`
 * imports from *this module's* location, so the bindings have to land in the
 * tree that resolves from here. For a globally installed CLI that is the global
 * root, and installing into the user's cwd would appear to succeed and then
 * still fail to load.
 */
function owningNodeModules(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    if (dir.endsWith(`${sep}node_modules`)) return dir;
    dir = parent;
  }
}

function npmGlobalRoot(): string | undefined {
  const result = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

/** The npm arguments that put the bindings where this module can import them. */
export function installArgs(
  forceGlobal: boolean,
  owning = owningNodeModules(),
  globalRoot = npmGlobalRoot(),
): string[] {
  if (forceGlobal) return ['install', '-g', OWS_PACKAGE];
  // Running from a source checkout: cwd is the only sensible target.
  if (!owning) return ['install', OWS_PACKAGE];
  // Installed globally: `-g` rather than a --prefix, so npm does not drop a
  // package.json next to the global root.
  if (globalRoot && join(globalRoot) === join(owning)) {
    return ['install', '-g', OWS_PACKAGE];
  }
  // Installed into a project: target that project, not wherever the shell is.
  return ['install', '--prefix', dirname(owning), OWS_PACKAGE];
}

/**
 * Install the OWS bindings, only ever with explicit consent. The exact command
 * is printed first: this runs a package manager on the user's machine, which is
 * not something to do quietly in a tool that spends money.
 */
function installOws(forceGlobal: boolean): string {
  const args = installArgs(forceGlobal);
  const printed = `npm ${args.join(' ')}`;
  process.stderr.write(`\nrunning: ${printed}\n\n`);
  const result = spawnSync('npm', args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `${printed} failed${result.error ? `: ${result.error.message}` : ''}. ` +
        `Install ${OWS_PACKAGE} yourself and re-run.`,
    );
  }
  return printed;
}

/** Load the bindings, offering to install them when they are missing. */
async function requireOws(opts: SetupOptions): Promise<{ ows: OwsCoreModule; installed?: string }> {
  try {
    return { ows: await loadOwsCore() };
  } catch {
    // Not installed. Ask, or take the flag; never install unasked.
    const permitted =
      opts.install === true ||
      (interactive() && (await confirm(`${OWS_PACKAGE} is not installed. Install it now?`, true)));
    if (!permitted) {
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        `${OWS_PACKAGE} is not installed. Run \`npm i ${OWS_PACKAGE}\` ` +
          '(add -g for the `ows` CLI too), or re-run with --install.',
      );
    }
    const installed = installOws(opts.installGlobal === true);
    try {
      return { ows: await loadOwsCore(), installed };
    } catch (err) {
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        // SAFETY: `.message` off a non-Error is `undefined`, not a throw.
        `${OWS_PACKAGE} still does not load after installing: ${(err as Error).message}. ` +
          'It ships prebuilt bindings for macOS and Linux on x64 and arm64 only.',
      );
    }
  }
}

/** OWS derives one account per chain family; x402 pays from the EVM one. */
function evmAddress(wallet: OwsWallet): string {
  const evm = wallet.accounts.find((a) => a.chainId.startsWith('eip155:'));
  if (!evm) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `OWS wallet "${wallet.name}" has no EVM account, so it cannot pay on Base`,
    );
  }
  return evm.address;
}

async function setupOws(opts: SetupOptions): Promise<SetupResult> {
  const { ows, installed } = await requireOws(opts);
  const name = opts.name ?? (interactive() ? await ask('Wallet name', 'x402-agent') : 'x402-agent');

  // Adopt an existing wallet rather than touching it. Creating over the top
  // could orphan a funded key, and this command must never destroy one.
  const existing = ows.listWallets(opts.vaultPath).find((w) => w.name === name);
  if (existing) {
    process.stderr.write(`\nOWS already has a wallet named "${name}"; using it.\n`);
    return finishOws(existing, name, opts, installed, false, true);
  }

  // The passphrase never comes from a flag: it would land in argv and in shell
  // history. Environment, or typed at the prompt with no echo.
  const fromEnv = process.env.OWS_VAULT_PASS;
  let passphrase = fromEnv ?? '';
  if (!fromEnv) {
    if (interactive()) {
      passphrase = await secretTwice('Vault passphrase (empty for none): ', 'Confirm passphrase: ');
    }
    if (!passphrase) {
      process.stderr.write(
        '\nWARNING creating the wallet with no passphrase. Anything that can read the\n' +
          '        vault can sign with this key. Set OWS_VAULT_PASS and use a fresh\n' +
          '        wallet before funding it.\n',
      );
    }
  }

  const created = ows.createWallet(name, passphrase || undefined, undefined, opts.vaultPath);
  return finishOws(created, name, opts, installed, true, passphrase !== '');
}

function finishOws(
  wallet: OwsWallet,
  name: string,
  opts: SetupOptions,
  installed: string | undefined,
  created: boolean,
  hasPassphrase: boolean,
): SetupResult {
  const configured: Record<string, string> = {
    'wallet.backend': 'ows-core',
    'wallet.default': name,
  };
  if (opts.vaultPath) configured['wallet.backends.ows-core.vaultPath'] = opts.vaultPath;
  // Written whenever the vault has a passphrase at all, not only when one is
  // already exported. It is an `env:` indirection, so the passphrase itself
  // never lands in config.json, and wiring it up now is what stops the failure
  // this setup would otherwise leave behind: the address resolves fine without
  // it, so `signer check` looks healthy and the *first* payment is what fails.
  if (hasPassphrase) {
    configured['wallet.backends.ows-core.passphrase'] = 'env:OWS_VAULT_PASS';
  }
  writeConfig(configured);

  const address = evmAddress(wallet);
  return {
    path: 'ows',
    backend: 'ows-core',
    wallet: name,
    address,
    configured,
    ...(installed ? { installed } : {}),
    nextSteps: [
      ...(hasPassphrase && !process.env.OWS_VAULT_PASS
        ? [
            'Export OWS_VAULT_PASS with the passphrase you just set, in every shell ' +
              'that will pay. Without it the address still resolves and `signer check` ' +
              'still passes — the first payment is what fails.',
          ]
        : []),
      `Fund ${address} with USDC on Base. Nothing can be paid until it holds some.`,
      'Set a spend cap: rh-x402 config set limits.maxPerCall 0.05',
      // Stated because `signer check` reports policies:false and an operator
      // should know what that costs them, not just that it says false.
      'For a binding policy layer, create an OWS API key bound to a policy ' +
        '(`ows policy create`, `ows key create`) and use the `ows` backend. ' +
        'In-process signing is owner access: the CLI-side caps are all that apply.',
      created ? 'Check it: rh-x402 signer check' : 'Existing wallet adopted; nothing was changed.',
    ],
  };
}

async function setupKeystore(
  path: 'import' | 'generate',
  opts: SetupOptions,
): Promise<SetupResult> {
  const name = opts.name ?? (interactive() ? await ask('Wallet name', 'dev') : 'dev');

  let privateKey: string;
  if (path === 'import') {
    const keyFile =
      opts.keyFile ??
      (interactive() ? await ask('Path to the key file (0600, hex private key)') : '');
    if (!keyFile) {
      throw new X402Error(
        ExitCode.GENERIC,
        'importing needs --key-file <path>: the key is read from a file, never from argv',
      );
    }
    privateKey = readKeyFile(keyFile);
  } else {
    privateKey = generatePrivateKey();
  }

  const fromEnv = process.env.X402_KEYSTORE_PASS;
  const passphrase =
    fromEnv ??
    (interactive()
      ? await secretTwice('Keystore passphrase: ', 'Confirm passphrase: ')
      : undefined);
  if (!passphrase) {
    throw new X402Error(
      ExitCode.GENERIC,
      'set X402_KEYSTORE_PASS to the passphrase that will encrypt this key',
    );
  }

  // Load ethers before writing anything: Node has no keccak256, so the address
  // needs it. Failing after `addEntry` would leave a key on disk under a name
  // the user believes failed.
  const { Wallet } = await loadEthers();
  const address = new Wallet(privateKey).address;
  const entry = addEntry({
    name,
    privateKey,
    address,
    passphrase,
    ...(opts.keystore ? { file: opts.keystore } : {}),
    replace: opts.replace === true,
  });

  const configured: Record<string, string> = {
    'wallet.backend': 'local',
    'wallet.default': name,
  };
  if (opts.keystore) configured['wallet.backends.local.keystore'] = opts.keystore;
  if (fromEnv) configured['wallet.backends.local.passphrase'] = 'env:X402_KEYSTORE_PASS';
  writeConfig(configured);

  return {
    path,
    backend: 'local',
    wallet: name,
    address: entry.address,
    configured,
    nextSteps: [
      `The key is at ${keystorePath(opts.keystore)}, encrypted, 0600.`,
      'The local backend has no policy layer: the CLI-side caps are the only ' +
        'spend control, and they are computed from a local ledger. Testnet and CI.',
      `Fund ${entry.address} with USDC on Base only if you accept that.`,
      'Set a spend cap: rh-x402 config set limits.maxPerCall 0.05',
    ],
  };
}

export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const path = await choosePath(opts);
  if (path === 'ows') return setupOws(opts);
  return setupKeystore(path, opts);
}
