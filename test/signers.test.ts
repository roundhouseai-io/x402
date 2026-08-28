import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, mergeDeep } from '../src/core/config.js';
import { ExitCode, X402Error } from '../src/core/errors.js';
import {
  resolveSigner,
  signerFactory,
  BUILTIN_BACKENDS,
  thirdPartyPackage,
} from '../src/core/signers/index.js';
import {
  ExecSigner,
  exitCodeForExecError,
  EXEC_PROTOCOL_VERSION,
} from '../src/core/signers/exec.js';
import {
  addEntry,
  readKeystore,
  decryptEntry,
  findEntry,
  readKeyFile,
  defaultKeystorePath,
  keystorePath,
  generatePrivateKey,
} from '../src/core/keystore.js';
import { TRANSFER_WITH_AUTHORIZATION_TYPES, type TypedData } from '../src/core/eip3009.js';
import {
  OwsCoreSigner,
  owsChainName,
  explainOwsCoreError,
  type OwsCoreModule,
} from '../src/core/signers/owscore.js';

const KEY = `0x${'11'.repeat(32)}`;
const ADDRESS = '0x000000000000000000000000000000000000dEaD';

const typedData: TypedData = {
  types: TRANSFER_WITH_AUTHORIZATION_TYPES,
  primaryType: 'TransferWithAuthorization',
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: ADDRESS },
  message: {
    from: ADDRESS,
    to: ADDRESS,
    value: '2000',
    validAfter: '0',
    validBefore: '99999999999',
    nonce: `0x${'00'.repeat(32)}`,
  },
};

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'x402-signer-'));
  process.env.X402_HOME = home;
});

afterEach(() => {
  delete process.env.X402_HOME;
  delete process.env.X402_KEYSTORE_PASS;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('keystore', () => {
  const file = () => join(home, 'keystore.json');

  it('seals a key with scrypt + AES-GCM and writes 0600', () => {
    const entry = addEntry({
      name: 'dev',
      privateKey: KEY,
      address: ADDRESS,
      passphrase: 'correct horse battery',
      file: file(),
    });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(entry.kdf.name).toBe('scrypt');
    expect(entry.cipher.name).toBe('aes-256-gcm');
    // The plaintext key must not appear anywhere in the file.
    expect(JSON.stringify(readKeystore(file()))).not.toContain(KEY.slice(2));
    expect(decryptEntry(entry, 'correct horse battery')).toBe(KEY);
  });

  it('generates a distinct, in-range secp256k1 key with no dependency', () => {
    // secp256k1 group order: a scalar must be in [1, n-1] or it is not a key.
    const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    const keys = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const key = generatePrivateKey();
      expect(key).toMatch(/^0x[0-9a-f]{64}$/);
      const scalar = BigInt(key);
      expect(scalar > 0n && scalar < N).toBe(true);
      keys.add(key);
    }
    expect(keys.size).toBe(8);
  });

  it('seals a generated key like any other', () => {
    const key = generatePrivateKey();
    const entry = addEntry({
      name: 'generated',
      privateKey: key,
      address: ADDRESS,
      passphrase: 'correct horse battery',
      file: file(),
    });
    expect(JSON.stringify(readKeystore(file()))).not.toContain(key.slice(2));
    expect(decryptEntry(entry, 'correct horse battery')).toBe(key);
  });

  it('rejects the wrong passphrase', () => {
    const entry = addEntry({
      name: 'dev',
      privateKey: KEY,
      address: ADDRESS,
      passphrase: 'correct horse battery',
      file: file(),
    });
    try {
      decryptEntry(entry, 'wrong passphrase');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as X402Error).code).toBe(ExitCode.OWS_UNREACHABLE);
    }
  });

  it('refuses a short passphrase and duplicate names', () => {
    const input = {
      name: 'dev',
      privateKey: KEY,
      address: ADDRESS,
      passphrase: 'correct horse battery',
      file: file(),
    };
    expect(() => addEntry({ ...input, passphrase: 'short' })).toThrow(/at least 8/);
    addEntry(input);
    expect(() => addEntry(input)).toThrow(/--replace/);
    expect(() => addEntry({ ...input, replace: true })).not.toThrow();
  });

  it('refuses a group- or world-readable keystore', () => {
    addEntry({
      name: 'dev',
      privateKey: KEY,
      address: ADDRESS,
      passphrase: 'correct horse battery',
      file: file(),
    });
    chmodSync(file(), 0o644);
    expect(() => readKeystore(file())).toThrow(/world-readable/);
  });

  it('names the wallets it does have when one is missing', () => {
    addEntry({
      name: 'dev',
      privateKey: KEY,
      address: ADDRESS,
      passphrase: 'correct horse battery',
      file: file(),
    });
    expect(() => findEntry(file(), 'nope')).toThrow(/have: dev/);
  });

  it('defaults to X402_HOME, never a developer real home directory', () => {
    expect(defaultKeystorePath()).toBe(join(home, 'keystore.json'));
    expect(keystorePath(undefined)).toBe(join(home, 'keystore.json'));
    expect(keystorePath('')).toBe(join(home, 'keystore.json'));
    expect(keystorePath('/tmp/elsewhere.json')).toBe('/tmp/elsewhere.json');

    // With no explicit file, the default location is where the entry lands.
    addEntry({
      name: 'dev',
      privateKey: KEY,
      address: ADDRESS,
      passphrase: 'correct horse battery',
    });
    expect(readKeystore().entries.map((e) => e.name)).toEqual(['dev']);
    expect(statSync(join(home, 'keystore.json')).mode & 0o777).toBe(0o600);
  });

  it('reads a key file but refuses a world-readable one', () => {
    const keyFile = join(home, 'key.hex');
    writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 });
    expect(readKeyFile(keyFile)).toBe(KEY);

    chmodSync(keyFile, 0o644);
    expect(() => readKeyFile(keyFile)).toThrow(/world-readable/);

    const bad = join(home, 'bad.hex');
    writeFileSync(bad, 'not-a-key', { mode: 0o600 });
    expect(() => readKeyFile(bad)).toThrow(/32-byte hex/);
  });
});

describe('backend resolution', () => {
  it('knows the built-in backends', () => {
    expect(BUILTIN_BACKENDS).toEqual(['ows', 'ows-core', 'local', 'exec']);
    expect(thirdPartyPackage('acme')).toBe('x402-signer-acme');
  });

  it('requires a wallet', async () => {
    await expect(resolveSigner(DEFAULT_CONFIG)).rejects.toThrow(/no wallet selected/);
  });

  it('reports an unknown backend as exit 47, naming the package it looked for', async () => {
    const config = mergeDeep(DEFAULT_CONFIG, { wallet: { backend: 'acme', default: 'w' } });
    try {
      await resolveSigner(config);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as X402Error).code).toBe(ExitCode.OWS_UNREACHABLE);
      expect((err as Error).message).toContain('x402-signer-acme');
    }
  });

  it('resolves the local backend and reports its capabilities', async () => {
    const config = mergeDeep(DEFAULT_CONFIG, {
      wallet: {
        backend: 'local',
        default: 'dev',
        backends: { local: { keystore: join(home, 'ks.json') } },
      },
    });
    const signer = await resolveSigner(config);
    expect(signer.backend).toBe('local');
    expect(await signer.capabilities()).toMatchObject({
      typedData: true,
      policies: false,
      declared: true,
    });
  });

  it('caches one signer per backend and wallet', async () => {
    const config = mergeDeep(DEFAULT_CONFIG, {
      wallet: {
        backend: 'local',
        default: 'dev',
        backends: { local: { keystore: join(home, 'ks.json') } },
      },
    });
    const factory = signerFactory(config);
    const [a, b, c] = await Promise.all([factory(), factory(), factory({ wallet: 'other' })]);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(c.wallet).toBe('other');
  });
});

describe('exec backend', () => {
  const helper = (bodyLines: string) => {
    const path = join(home, 'signer.mjs');
    writeFileSync(
      path,
      `import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
${bodyLines}
`,
      { mode: 0o700 },
    );
    return path;
  };

  const configFor = (command: string, args: string[] = []) =>
    mergeDeep(DEFAULT_CONFIG, {
      wallet: {
        backend: 'exec',
        default: 'dev',
        backends: { exec: { command, args, timeoutMs: 10_000 } },
      },
    });

  it('speaks JSON over stdio and signs', async () => {
    const path = helper(`
const reply = (result) => process.stdout.write(JSON.stringify({ x402Signer: 1, id: input.id, result }) + '\\n');
if (input.method === 'capabilities') reply({ typedData: true, policies: true, accounts: true });
else if (input.method === 'getAddress') reply({ address: '${ADDRESS}' });
else if (input.method === 'getAccounts') reply({ accounts: [{ id: 'dev', address: '${ADDRESS}' }] });
else if (input.method === 'signTypedData') reply({ signature: '0x' + 'ef'.repeat(65), echo: input.params.typedData.message.value });
else process.stdout.write(JSON.stringify({ error: { code: 'unsupported', message: input.method } }) + '\\n');
`);
    const config = configFor(process.execPath, [path]);
    const signer = await resolveSigner(config);
    expect(signer.backend).toBe('exec');
    expect(await signer.capabilities()).toMatchObject({
      typedData: true,
      policies: true,
      declared: true,
    });
    expect(await signer.getAddress()).toBe(ADDRESS);
    expect(await signer.getAccounts()).toEqual([
      { id: 'dev', address: ADDRESS, chains: undefined },
    ]);
    expect(await signer.signTypedData(typedData)).toBe(`0x${'ef'.repeat(65)}`);
  });

  it('fails at resolution when the helper cannot do typed data (exit 47)', async () => {
    const path = helper(
      `process.stdout.write(JSON.stringify({ x402Signer: 1, id: input.id, result: { typedData: false } }) + '\\n');`,
    );
    try {
      await resolveSigner(configFor(process.execPath, [path]));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as X402Error).code).toBe(ExitCode.OWS_UNREACHABLE);
      expect((err as Error).message).toMatch(/cannot sign EIP-712/);
    }
  });

  it('maps a helper refusal onto exit 42', async () => {
    const path = helper(`
if (input.method === 'capabilities') process.stdout.write(JSON.stringify({ result: { typedData: true, policies: true } }) + '\\n');
else process.stdout.write(JSON.stringify({ error: { code: 'policy_denied', message: 'over daily limit' } }) + '\\n');
`);
    const signer = await resolveSigner(configFor(process.execPath, [path]));
    try {
      await signer.signTypedData(typedData);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as X402Error).code).toBe(ExitCode.POLICY_DENIED);
      expect((err as Error).message).toContain('over daily limit');
    }
  });

  it('reports a missing executable as exit 47', async () => {
    const signer = new ExecSigner('dev', { command: join(home, 'does-not-exist') });
    try {
      await signer.capabilities();
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as X402Error).code).toBe(ExitCode.OWS_UNREACHABLE);
    }
  });

  it('never hands the helper anything but the typed data', async () => {
    const seen = join(home, 'seen.json');
    const path = helper(`
import { writeFileSync } from 'node:fs';
if (input.method === 'signTypedData') writeFileSync('${seen}', JSON.stringify(input));
process.stdout.write(JSON.stringify({ result: { typedData: true, signature: '0x' + 'ab'.repeat(65) } }) + '\\n');
`);
    const signer = await resolveSigner(configFor(process.execPath, [path]));
    await signer.signTypedData(typedData);
    const request = JSON.parse((await import('node:fs')).readFileSync(seen, 'utf8'));
    expect(request.x402Signer).toBe(EXEC_PROTOCOL_VERSION);
    expect(Object.keys(request.params).sort()).toEqual(['typedData', 'wallet']);
    expect(JSON.stringify(request)).not.toContain('http');
  });

  it('maps helper error codes onto the CLI taxonomy', () => {
    expect(exitCodeForExecError('policy_denied')).toBe(ExitCode.POLICY_DENIED);
    expect(exitCodeForExecError('insufficient_balance')).toBe(ExitCode.INSUFFICIENT_BALANCE);
    expect(exitCodeForExecError('unsupported')).toBe(ExitCode.OWS_UNREACHABLE);
    expect(exitCodeForExecError('auth_failed')).toBe(ExitCode.OWS_UNREACHABLE);
    expect(exitCodeForExecError(undefined)).toBe(ExitCode.GENERIC);
  });
});

describe('ows-core backend', () => {
  const SIG_BODY = `${'ab'.repeat(64)}1b`;

  const wallet = (accounts: Array<{ chainId: string; address: string }>) => ({
    id: 'w1',
    name: 'agent',
    accounts,
  });

  const evmWallet = wallet([
    { chainId: 'eip155:8453', address: ADDRESS },
    { chainId: 'solana:mainnet', address: 'So1111' },
  ]);

  /** A stand-in for the native bindings, so the sign path runs without them. */
  const fakeCore = (over: Partial<OwsCoreModule> = {}): OwsCoreModule => ({
    listWallets: () => [evmWallet],
    getWallet: () => evmWallet,
    createWallet: () => evmWallet,
    signTypedData: () => ({ signature: SIG_BODY, recoveryId: 27 }),
    ...over,
  });

  const signerWith = (core: OwsCoreModule) => new OwsCoreSigner('agent', {}, async () => core);

  it('declares typed-data signing, but neither policies nor balances', async () => {
    expect(await signerWith(fakeCore()).capabilities()).toEqual({
      typedData: true,
      // Not `true`: OWS policies gate API-key callers, and in-process signing
      // has no key to bind one to. See the comment on capabilities().
      policies: false,
      balances: false,
      accounts: true,
      declared: true,
    });
  });

  it('adds the 0x prefix the bindings omit', async () => {
    const signature = await signerWith(fakeCore()).signTypedData(typedData);
    expect(signature).toBe(`0x${SIG_BODY}`);

    // Already-prefixed output must survive unchanged, not gain a second prefix.
    const prefixed = fakeCore({ signTypedData: () => ({ signature: `0x${SIG_BODY}` }) });
    expect(await signerWith(prefixed).signTypedData(typedData)).toBe(`0x${SIG_BODY}`);
  });

  it('rejects a signature that is not 65 bytes rather than paying with it', async () => {
    const short = fakeCore({ signTypedData: () => ({ signature: 'ab'.repeat(64) }) });
    await expect(signerWith(short).signTypedData(typedData)).rejects.toThrow(/64-byte signature/);
  });

  it('maps a policy refusal to 42 and an outage to 47', async () => {
    const denied = fakeCore({
      signTypedData: () => {
        throw new Error('policy denied: over the per-transaction cap');
      },
    });
    await expect(signerWith(denied).signTypedData(typedData)).rejects.toMatchObject({
      code: ExitCode.POLICY_DENIED,
    });

    const broken = fakeCore({
      signTypedData: () => {
        throw new Error('vault is locked');
      },
    });
    await expect(signerWith(broken).signTypedData(typedData)).rejects.toMatchObject({
      code: ExitCode.OWS_UNREACHABLE,
    });
  });

  it('explains a wrong vault passphrase instead of naming an AEAD library', async () => {
    // This one is worth a test because everything else looks healthy: the
    // address resolves without the passphrase, so `signer check` passes and the
    // first *payment* is what fails.
    const locked = fakeCore({
      signTypedData: () => {
        throw new Error('decryption failed: aead::Error');
      },
    });
    await expect(signerWith(locked).signTypedData(typedData)).rejects.toThrow(
      /passphrase is wrong or missing/,
    );
    // The original text is kept, not swallowed.
    await expect(signerWith(locked).signTypedData(typedData)).rejects.toThrow(/aead::Error/);
    expect(explainOwsCoreError('vault is locked')).toBe('vault is locked');
  });

  it('names EVM chains the way OWS does', () => {
    expect(owsChainName('8453')).toBe('base');
    expect(owsChainName('84532')).toBe('base-sepolia');
    // Unknown ids pass through: OWS should reject them, not this mapping.
    expect(owsChainName('999999')).toBe('999999');
  });

  it('pays from the EVM account, and says so when there is none', async () => {
    expect(await signerWith(fakeCore()).getAddress()).toBe(ADDRESS);
    expect(await signerWith(fakeCore()).getAccounts()).toEqual([
      { id: 'agent', address: ADDRESS, chains: ['eip155:8453', 'solana:mainnet'] },
    ]);

    const solanaOnly = wallet([{ chainId: 'solana:mainnet', address: 'So1111' }]);
    const noEvm = fakeCore({ getWallet: () => solanaOnly });
    await expect(signerWith(noEvm).getAddress()).rejects.toThrow(/no EVM account/);
  });

  it('reports a missing wallet as exit 47, naming it', async () => {
    const missing = fakeCore({
      getWallet: () => {
        throw new Error('not found');
      },
    });
    await expect(signerWith(missing).getAddress()).rejects.toThrow(
      /ows-core has no wallet "agent"/,
    );
  });

  it('reports the absent optional peer dependency as exit 47, naming the package', async () => {
    // The real loader, with the package genuinely not installed.
    try {
      await new OwsCoreSigner('agent').signTypedData(typedData);
      throw new Error('should have thrown');
    } catch (err) {
      // SAFETY: the assertion above proves this path threw; the two reads below
      // fail the test if it was not an X402Error, which is the assertion.
      expect((err as X402Error).code).toBe(ExitCode.OWS_UNREACHABLE);
      expect((err as Error).message).toContain('@open-wallet-standard/core');
    }
  });

  it('resolves through the backend registry', async () => {
    const config = mergeDeep(DEFAULT_CONFIG, {
      wallet: { backend: 'ows-core', default: 'agent' },
    });
    const signer = await resolveSigner(config);
    expect(signer.backend).toBe('ows-core');
    expect(signer.wallet).toBe('agent');
  });
});
