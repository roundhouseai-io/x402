import { X402Error, ExitCode } from '../core/errors.js';
import { writeJson, isTty, writeErr } from '../core/output.js';
import { bool, str, type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';
import { BUILTIN_BACKENDS, resolveSigner } from '../core/signers/index.js';
import { addEntry, readKeystore, readKeyFile, keystorePath } from '../core/keystore.js';
import { loadEthers } from '../core/signers/local.js';
import type { LocalBackendConfig } from '../core/config.js';

/**
 * Inspect and configure signer backends. The payment engine never touches key
 * material; this is where the wallet side is set up and checked.
 */
export async function signerCommand(parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0] ?? 'list';
  if (sub === 'keystore') return keystoreSubcommand(parsed);

  const ctx = buildContext(parsed);

  if (sub === 'list') {
    const backends = [
      ...new Set([...BUILTIN_BACKENDS, ...Object.keys(ctx.config.wallet.backends)]),
    ];
    const rows = backends.map((name) => ({
      backend: name,
      active: name === ctx.backendName,
      builtin: (BUILTIN_BACKENDS as readonly string[]).includes(name),
      configured: ctx.config.wallet.backends[name] !== undefined,
    }));
    if (isTty()) {
      for (const row of rows) {
        process.stdout.write(
          `${row.active ? '*' : ' '} ${row.backend.padEnd(10)} ` +
            `${row.builtin ? 'built-in' : 'third-party'}${row.configured ? '' : '  (not configured)'}\n`,
        );
      }
    } else {
      writeJson({
        ok: true,
        active: ctx.backendName,
        wallet: ctx.walletName ?? null,
        backends: rows,
      });
    }
    return ExitCode.OK;
  }

  if (sub === 'check') {
    // Resolving performs the config-time capability check: a backend that
    // declares it cannot sign typed data fails here, not mid-payment.
    const backend = parsed.positionals[1] ?? ctx.backendName;
    const signer = await resolveSigner(ctx.config, { backend, wallet: ctx.walletName });
    const capabilities = await signer.capabilities();
    let address: string | undefined;
    let error: string | undefined;
    try {
      address = await signer.getAddress();
    } catch (err) {
      error = (err as Error).message;
    }
    if (isTty()) {
      process.stdout.write(
        `${backend}: typedData=${capabilities.typedData} policies=${capabilities.policies} ` +
          `balances=${capabilities.balances}${capabilities.declared ? '' : ' (assumed, not declared)'}\n` +
          `wallet ${signer.wallet}: ${address ?? `unavailable (${error})`}\n`,
      );
    } else {
      writeJson({
        ok: address !== undefined,
        backend,
        wallet: signer.wallet,
        capabilities,
        address: address ?? null,
        ...(error ? { error } : {}),
      });
    }
    return address === undefined ? ExitCode.OWS_UNREACHABLE : ExitCode.OK;
  }

  throw new X402Error(ExitCode.GENERIC, 'usage: x402 signer <list|check|keystore>');
}

async function keystoreSubcommand(parsed: ParsedArgs): Promise<number> {
  const action = parsed.positionals[1] ?? 'list';
  const ctx = buildContext(parsed);
  const local = (ctx.config.wallet.backends.local ?? {}) as LocalBackendConfig;
  const file = str(parsed.flags, 'keystore') ?? local.keystore;

  if (action === 'list') {
    const entries = readKeystore(file).entries.map((e) => ({
      name: e.name,
      address: e.address,
      createdAt: e.createdAt,
    }));
    if (isTty()) {
      if (entries.length === 0) process.stdout.write(`no entries in ${keystorePath(file)}\n`);
      for (const e of entries) process.stdout.write(`${e.name.padEnd(20)} ${e.address}\n`);
    } else {
      writeJson({ ok: true, keystore: keystorePath(file), entries });
    }
    return ExitCode.OK;
  }

  if (action === 'add') {
    const name = parsed.positionals[2];
    const keyFile = str(parsed.flags, 'key-file');
    if (!name || !keyFile) {
      throw new X402Error(
        ExitCode.GENERIC,
        'usage: x402 signer keystore add <name> --key-file <path> [--replace]\n' +
          '       passphrase comes from X402_KEYSTORE_PASS',
      );
    }
    const passphrase = process.env.X402_KEYSTORE_PASS;
    if (!passphrase) {
      throw new X402Error(
        ExitCode.GENERIC,
        'set X402_KEYSTORE_PASS to the passphrase that will encrypt this key',
      );
    }

    const privateKey = readKeyFile(keyFile);
    const { Wallet } = await loadEthers();
    const address = new Wallet(privateKey).address;
    const entry = addEntry({
      name,
      privateKey,
      address,
      passphrase,
      file,
      replace: bool(parsed.flags, 'replace'),
    });

    writeErr(
      'the local backend is for development and CI only: it has no policy layer, ' +
        'so only the CLI-side spend caps apply to this key',
    );
    if (isTty()) {
      process.stdout.write(`added ${entry.name}  ${entry.address}  -> ${keystorePath(file)}\n`);
    } else {
      writeJson({
        ok: true,
        keystore: keystorePath(file),
        name: entry.name,
        address: entry.address,
      });
    }
    return ExitCode.OK;
  }

  throw new X402Error(ExitCode.GENERIC, 'usage: x402 signer keystore <list|add>');
}
