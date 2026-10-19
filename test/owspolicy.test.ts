import { describe, it, expect } from 'vitest';
import { buildX402Policy, resolveExpiry, grantPolicyKey } from '../src/core/owspolicy.js';
import { OwsCoreSigner, type OwsCoreModule, type OwsWallet } from '../src/core/signers/owscore.js';
import { TRANSFER_WITH_AUTHORIZATION_TYPES, type TypedData } from '../src/core/eip3009.js';
import { ExitCode } from '../src/core/errors.js';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ADDRESS = '0x000000000000000000000000000000000000dEaD';

const typedData: TypedData = {
  types: TRANSFER_WITH_AUTHORIZATION_TYPES,
  primaryType: 'TransferWithAuthorization',
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_USDC },
  message: {
    from: ADDRESS,
    to: ADDRESS,
    value: '2000',
    validAfter: '0',
    validBefore: '99999999999',
    nonce: `0x${'00'.repeat(32)}`,
  },
};

describe('building an x402 policy', () => {
  const now = new Date('2026-08-28T00:00:00.000Z');

  it('allows exactly the chain and the token contract, and nothing else', () => {
    const policy = buildX402Policy({ id: 'p', name: 'n', chains: ['base'], now });
    expect(policy).toEqual({
      id: 'p',
      name: 'n',
      version: 1,
      created_at: '2026-08-28T00:00:00.000Z',
      // OWS accepts only `deny`: the rules say what is allowed, this says what
      // happens to everything else.
      action: 'deny',
      rules: [
        { type: 'allowed_chains', chain_ids: ['eip155:8453'] },
        { type: 'allowed_typed_data_contracts', contracts: [BASE_USDC] },
      ],
    });
  });

  it('carries an expiry only when one was asked for', () => {
    const policy = buildX402Policy({
      id: 'p',
      name: 'n',
      chains: ['base'],
      expiresAt: '2026-09-27T00:00:00.000Z',
      now,
    });
    expect(policy.rules).toContainEqual({
      type: 'expires_at',
      timestamp: '2026-09-27T00:00:00.000Z',
    });
  });

  it('takes any spelling of a chain the rest of the CLI accepts', () => {
    for (const spelling of ['base', 'eip155:8453', '8453', 'BASE']) {
      const policy = buildX402Policy({ id: 'p', name: 'n', chains: [spelling], now });
      expect(policy.rules[0]).toEqual({ type: 'allowed_chains', chain_ids: ['eip155:8453'] });
    }
  });

  it('refuses an unknown chain rather than registering a policy that denies everything', () => {
    // Not `ethereum` — that is a known chain now. Something genuinely absent.
    expect(() => buildX402Policy({ id: 'p', name: 'n', chains: ['polygon'], now })).toThrow(
      /unknown chain "polygon"/,
    );
    expect(() => buildX402Policy({ id: 'p', name: 'n', chains: [], now })).toThrow(
      /at least one chain/,
    );
  });

  it('refuses a chain the CLI does not pay on, however well known it is', () => {
    // Ethereum is in the chain table so `wallet balance` can read it. Letting a
    // policy allow signing there would grant more than the engine can use, and
    // an allowlist that is wider than the thing it guards is not a control.
    expect(() => buildX402Policy({ id: 'p', name: 'n', chains: ['ethereum'], now })).toThrow(
      /ethereum is not a chain this CLI pays on/,
    );
  });

  it('covers every known asset on the chosen chains', () => {
    const policy = buildX402Policy({ id: 'p', name: 'n', chains: ['base', 'base-sepolia'], now });
    const contracts = policy.rules.find((r) => r.type === 'allowed_typed_data_contracts');
    expect(contracts).toBeDefined();
    expect(contracts && 'contracts' in contracts && contracts.contracts).toHaveLength(2);
  });
});

describe('expiry', () => {
  const now = new Date('2026-08-28T00:00:00.000Z');

  it('accepts durations and ISO instants', () => {
    expect(resolveExpiry('30d', now)).toBe('2026-09-27T00:00:00.000Z');
    expect(resolveExpiry('12h', now)).toBe('2026-08-28T12:00:00.000Z');
    expect(resolveExpiry('2w', now)).toBe('2026-09-11T00:00:00.000Z');
    expect(resolveExpiry('2026-12-25T00:00:00Z', now)).toBe('2026-12-25T00:00:00.000Z');
    expect(resolveExpiry(undefined, now)).toBeUndefined();
  });

  it('refuses something that is neither', () => {
    expect(() => resolveExpiry('soon', now)).toThrow(/neither a duration/);
  });
});

describe('granting a policy key', () => {
  const wallet: OwsWallet = {
    id: 'w1',
    name: 'agent',
    accounts: [{ chainId: 'eip155:8453', address: ADDRESS }],
  };

  const core = (over: Partial<OwsCoreModule> = {}): OwsCoreModule => ({
    listWallets: () => [wallet],
    getWallet: () => wallet,
    createWallet: () => wallet,
    createPolicy: () => undefined,
    createApiKey: () => ({ token: 'ows_key_abc', id: 'k1', name: 'x402-agent' }),
    signTypedData: () => ({ signature: `${'ab'.repeat(64)}1b` }),
    ...over,
  });

  it('registers the policy and binds a key to it', async () => {
    const seen: string[] = [];
    const grant = await grantPolicyKey({ wallet: 'agent', chains: ['base'] }, async () =>
      core({
        createPolicy: (json) => {
          seen.push(json);
        },
      }),
    );
    expect(grant.token).toBe('ows_key_abc');
    expect(grant.policy.id).toBe('x402-agent');
    expect(seen[0]).toContain('allowed_typed_data_contracts');
  });

  it('treats re-registering the same policy as a re-run, not a failure', async () => {
    const grant = await grantPolicyKey({ wallet: 'agent', chains: ['base'] }, async () =>
      core({
        createPolicy: () => {
          throw new Error('policy x402-agent already exists');
        },
      }),
    );
    expect(grant.token).toBe('ows_key_abc');
  });

  it('says the passphrase is the problem when the key cannot be bound', async () => {
    await expect(
      grantPolicyKey({ wallet: 'agent', chains: ['base'] }, async () =>
        core({
          createApiKey: () => {
            throw new Error('decryption failed');
          },
        }),
      ),
    ).rejects.toThrow(/vault passphrase must be the one this wallet was created with/);
  });
});

describe('the credential the backend signs with', () => {
  const wallet: OwsWallet = {
    id: 'w1',
    name: 'agent',
    accounts: [{ chainId: 'eip155:8453', address: ADDRESS }],
  };

  interface CredentialSpy {
    core: OwsCoreModule;
    seen: (string | undefined)[];
  }

  /** Records which credential OWS was handed, which is the whole question. */
  const spy = (): CredentialSpy => {
    const seen: (string | undefined)[] = [];
    return {
      seen,
      core: {
        listWallets: () => [wallet],
        getWallet: () => wallet,
        createWallet: () => wallet,
        createPolicy: () => undefined,
        createApiKey: () => ({ token: 'ows_key_abc', id: 'k1', name: 'n' }),
        signTypedData: (_w, _c, _j, credential) => {
          seen.push(credential);
          return { signature: `${'ab'.repeat(64)}1b` };
        },
      },
    };
  };

  it('prefers the API key, because that is what puts the policy in front', async () => {
    const { core, seen } = spy();
    const signer = new OwsCoreSigner(
      'agent',
      { apiKey: 'ows_key_abc', passphrase: 'vault-pass' },
      async () => core,
    );
    await signer.signTypedData(typedData);
    expect(seen).toEqual(['ows_key_abc']);
    expect(await signer.capabilities()).toMatchObject({ policies: true });
  });

  it('reports no policy layer when signing with the passphrase', async () => {
    const { core, seen } = spy();
    const signer = new OwsCoreSigner('agent', { passphrase: 'vault-pass' }, async () => core);
    await signer.signTypedData(typedData);
    expect(seen).toEqual(['vault-pass']);
    // Owner access. OWS gates policies on API-key callers, so this signs
    // whatever it is asked to and must not claim otherwise.
    expect(await signer.capabilities()).toMatchObject({ policies: false });
  });

  it('refuses to sign rather than silently dropping to owner access', async () => {
    // The failure this prevents: `apiKey: env:OWS_X402_KEY` resolves to
    // undefined in a shell that never exported it. Falling back would keep
    // payments working with the policy quietly gone.
    const { core, seen } = spy();
    const signer = new OwsCoreSigner(
      'agent',
      { passphrase: 'vault-pass', requireApiKey: true },
      async () => core,
    );
    await expect(signer.signTypedData(typedData)).rejects.toMatchObject({
      code: ExitCode.OWS_UNREACHABLE,
    });
    await expect(signer.signTypedData(typedData)).rejects.toThrow(/Refusing to fall back/);
    expect(seen).toEqual([]);
    // Still true: nothing this backend signs can bypass the policy.
    expect(await signer.capabilities()).toMatchObject({ policies: true });
  });
});
