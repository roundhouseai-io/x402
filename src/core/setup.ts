import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { X402Error, ExitCode, errnoCode, messageOf } from './errors.js';
import { readRawConfig, writeRawConfig, setPath, unsetPath } from './config.js';

/** What the guided setup and `wallet forget` write into config.json. */
export type ConfigValue = string | boolean | string[];

/** Dotted config key -> the value written there. */
export interface ConfigEntries {
  [key: string]: ConfigValue;
}
import {
  addEntry,
  generatePrivateKey,
  readKeyFile,
  keystorePath,
  type AddEntryInput,
} from './keystore.js';
import { ETHERS_INSTALL_HINT, ethersAvailable, loadEthers } from './signers/local.js';
import { loadOwsCore, type OwsCoreModule, type OwsWallet } from './signers/owscore.js';
import { ask, confirm, interactive, secretTwice, select } from './prompt.js';
import { grantPolicyKey, type GrantOptions } from './owspolicy.js';

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
  /** Also register an OWS policy and mint the API key that carries it. */
  policy?: boolean;
  chains?: string[];
  expires?: string;
}

export interface SetupResult {
  path: KeyPath;
  backend: string;
  wallet: string;
  address: string;
  /** Dotted config keys this wrote, so the caller can show its work. */
  configured: ConfigEntries;
  /** Things the operator still has to do; never empty for a funded wallet. */
  nextSteps: string[];
  installed?: string;
  /** Present when a policy was registered; the token is shown once, never stored. */
  policy?: { id: string; keyId: string; token: string };
}

function isKeyPath(value: string): value is KeyPath {
  return KEY_PATHS.some((path) => path === value);
}

/** Config is written key by key, the same way `config set` writes it. */
export function writeConfig(entries: ConfigEntries): void {
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

/**
 * What to say when a global install cannot work.
 *
 * Never `sudo`: a package that handles a hot wallet should not be installed as
 * root, and an agent told to prefix a command with `sudo` will. Both
 * alternatives need no elevated rights and leave the machine as it was.
 */
export const NO_SUDO_GUIDANCE =
  'The global npm directory is not writable by this user. Do not use sudo. ' +
  'Run it without installing: `npx @roundhouseai/x402 <command>`. Or install into a project ' +
  '(`npm i @roundhouseai/x402`, then `npx rh-x402`). Or give npm a prefix you own: ' +
  '`npm config set prefix ~/.npm-global` and put `~/.npm-global/bin` on PATH.';

/**
 * Whether this user can write where `npm i -g` would put things.
 *
 * Walks up to the nearest directory that exists, since the global root itself
 * is often not created until the first install. `undefined` means npm would not
 * say where the root is, which is not evidence that it is unwritable.
 */
export function globalRootWritable(
  root: string | null | undefined = npmGlobalRoot(),
): boolean | undefined {
  if (!root) return undefined;
  let dir = root;
  for (;;) {
    try {
      accessSync(dir, constants.W_OK);
      return true;
    } catch (err) {
      // Anything but "does not exist yet" ends the walk as "not writable".
      if (errnoCode(err) !== 'ENOENT') return false;
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
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
 * npm's own stdout goes to *our stderr*, not our stdout.
 *
 * stdout is the machine-readable envelope, and a plain `inherit` puts npm's
 * "added 2 packages" ahead of the JSON, so anything parsing this command's
 * output gets a syntax error instead of a wallet. The operator still sees the
 * install progress; it is just on the stream that carries progress.
 */
export const INSTALL_STDIO = ['inherit', 2, 'inherit'] as const;

/**
 * Install the OWS bindings, only ever with explicit consent. The exact command
 * is printed first: this runs a package manager on the user's machine, which is
 * not something to do quietly in a tool that spends money.
 */
function installOws(forceGlobal: boolean): string {
  const args = installArgs(forceGlobal);
  const printed = `npm ${args.join(' ')}`;
  // Checked before npm runs, so the failure is a sentence rather than an EACCES
  // stack trace from a child process whose output we cannot read back.
  if (args.includes('-g') && globalRootWritable() === false) {
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `${printed} would fail: ${NO_SUDO_GUIDANCE} Or install ${OWS_PACKAGE} somewhere you own and re-run.`,
    );
  }
  process.stderr.write(`\nrunning: ${printed}\n\n`);
  const result = spawnSync('npm', args, { stdio: [...INSTALL_STDIO] });
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
        `${OWS_PACKAGE} still does not load after installing: ${messageOf(err)}. ` +
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
    return finishOws(existing, name, opts, installed, false, true, undefined);
  }

  // The passphrase never comes from a flag: it would land in argv and in shell
  // history. Environment, or typed at the prompt with no echo.
  const fromEnv = process.env.OWS_VAULT_PASS;
  let passphrase = fromEnv ?? '';
  if (!fromEnv) {
    if (interactive()) {
      // Name the escape hatch in the prompt: this is the one question `wallet
      // create` cannot take as a flag (it would land in argv and shell
      // history), so a caller driving the command from a script needs to know
      // the variable exists before it stops to ask.
      passphrase = await secretTwice(
        'Vault passphrase (empty for none; set OWS_VAULT_PASS to skip this prompt): ',
        'Confirm passphrase: ',
      );
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
  const grant = await maybeGrantPolicy(name, passphrase, opts);
  return finishOws(created, name, opts, installed, true, passphrase !== '', grant);
}

/**
 * Offer the policy, because a wallet without one is owner access: this CLI can
 * sign anything the key can sign, and the only caps are the ones it applies to
 * itself. Declined is a valid answer, and it is recorded in what gets printed.
 */
async function maybeGrantPolicy(
  wallet: string,
  passphrase: string,
  opts: SetupOptions,
): Promise<SetupResult['policy']> {
  const wanted =
    opts.policy ??
    (interactive() &&
      (await confirm(
        'Put an OWS policy in front of this wallet? It refuses any chain or token ' +
          'contract outside x402, inside OWS, whatever this CLI does.',
        true,
      )));
  if (!wanted) return undefined;

  const grantOptions: GrantOptions = {
    wallet,
    chains: opts.chains && opts.chains.length > 0 ? opts.chains : ['base'],
  };
  if (opts.expires) grantOptions.expires = opts.expires;
  if (opts.vaultPath) grantOptions.vaultPath = opts.vaultPath;
  if (passphrase) grantOptions.passphrase = passphrase;
  const grant = await grantPolicyKey(grantOptions);
  return { id: grant.policy.id, keyId: grant.keyId, token: grant.token };
}

function finishOws(
  wallet: OwsWallet,
  name: string,
  opts: SetupOptions,
  installed: string | undefined,
  created: boolean,
  hasPassphrase: boolean,
  policy: SetupResult['policy'],
): SetupResult {
  const configured: ConfigEntries = {
    'wallet.backend': 'ows-core',
    'wallet.default': name,
    'wallet.path': 'ows',
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
  // With a key configured the backend signs through the policy engine instead
  // of the passphrase, which is the whole point of having registered one.
  if (policy) {
    configured['wallet.backends.ows-core.apiKey'] = 'env:OWS_X402_KEY';
    configured['wallet.backends.ows-core.requireApiKey'] = true;
  }
  writeConfig(configured);

  const address = evmAddress(wallet);
  const result: SetupResult = {
    path: 'ows',
    backend: 'ows-core',
    wallet: name,
    address,
    configured,
    nextSteps: [
      ...(policy
        ? [
            `export OWS_X402_KEY=${policy.token}  — OWS shows this token once and cannot ` +
              'show it again. Without it the backend falls back to the vault passphrase, ' +
              'which is owner access and gated by nothing.',
            'The policy bounds WHAT may be signed (chain, token contract, expiry). OWS has ' +
              'no amount rule, so limits.maxPerCall is still the only cap on HOW MUCH.',
          ]
        : [
            'No policy: this wallet is owner access, so the CLI-side caps are the only ' +
              'spend control. Add one later with `rh-x402 wallet policy`.',
          ]),
      ...(hasPassphrase && !process.env.OWS_VAULT_PASS
        ? [
            'Export OWS_VAULT_PASS with the passphrase you just set, in every shell ' +
              'that will pay. Without it the address still resolves and `signer check` ' +
              'still passes — the first payment is what fails.',
          ]
        : []),
      `Fund ${address} with USDC on Base. Nothing can be paid until it holds some.`,
      'Set a spend cap: rh-x402 config set limits.maxPerCall 0.05',
      created ? 'Check it: rh-x402 signer check' : 'Existing wallet adopted; nothing was changed.',
    ],
  };
  if (installed) result.installed = installed;
  if (policy) result.policy = policy;
  return result;
}

async function setupKeystore(
  path: 'import' | 'generate',
  opts: SetupOptions,
): Promise<SetupResult> {
  // Check everything this path needs before asking for anything or making a
  // key. Both used to surface one at a time, the passphrase first and ethers
  // only after it was fixed, and neither was mentioned before the run.
  const missing: string[] = [];
  if (path === 'import' && !opts.keyFile && !interactive()) {
    missing.push('importing needs --key-file <path>: the key is read from a file, never from argv');
  }
  const ethersOk = await ethersAvailable();
  if (!ethersOk)
    missing.push(
      `the optional peer dependency \`ethers\` is not installed: ${ETHERS_INSTALL_HINT}`,
    );
  if (!process.env.X402_KEYSTORE_PASS && !interactive()) {
    missing.push(
      'X402_KEYSTORE_PASS is not set: export it with the passphrase that will encrypt this key. ' +
        'Every shell that pays needs it too.',
    );
  }
  if (missing.length > 0) {
    throw new X402Error(
      ethersOk ? ExitCode.GENERIC : ExitCode.OWS_UNREACHABLE,
      `--path ${path} needs ${missing.length === 1 ? 'one thing' : `${missing.length} things`} first. Nothing was written.\n` +
        missing.map((m) => `  - ${m}`).join('\n'),
    );
  }

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
  const entryInput: AddEntryInput = {
    name,
    privateKey,
    address,
    passphrase,
    replace: opts.replace === true,
  };
  if (opts.keystore) entryInput.file = opts.keystore;
  const entry = addEntry(entryInput);

  const configured: ConfigEntries = {
    'wallet.backend': 'local',
    'wallet.default': name,
    'wallet.path': path,
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

/** Remove a key from config.json, the counterpart to `writeConfig`. */
export function unsetConfig(key: string): boolean {
  const { config, removed } = unsetPath(readRawConfig(), key);
  writeRawConfig(config);
  return removed;
}
