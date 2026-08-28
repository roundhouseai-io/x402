import { X402Error, ExitCode } from './errors.js';
import { CHAINS, ASSETS, caip2, findChain } from './assets.js';
import { loadOwsCore, type OwsCoreModule } from './signers/owscore.js';

/**
 * OWS policies, built from this CLI's own chain and asset tables.
 *
 * A policy is what makes a spend control *bind*. `limits.maxPerCall` and
 * `limits.dailyCap` are computed from a local ledger by the same process that
 * signs, so they stop mistakes; an OWS policy is evaluated inside OWS, before
 * the key is decrypted, and refuses regardless of what this CLI does next.
 *
 * The schema below was established against `@open-wallet-standard/core@1.4.2`
 * by registering policies and reading back what it rejected.
 */

/** The rule variants OWS accepts. There is deliberately no amount rule — see below. */
export type OwsPolicyRule =
  | { type: 'allowed_chains'; chain_ids: string[] }
  | { type: 'allowed_typed_data_contracts'; contracts: string[] }
  | { type: 'expires_at'; timestamp: string };

export interface OwsPolicy {
  id: string;
  name: string;
  version: number;
  created_at: string;
  /** OWS accepts only `deny`: the rules say what is allowed, this says what happens otherwise. */
  action: 'deny';
  rules: OwsPolicyRule[];
}

export interface PolicyInput {
  id: string;
  name: string;
  /** Chain names or ids, as the rest of the CLI spells them. */
  chains: string[];
  expiresAt?: string;
  now?: Date;
}

/**
 * The policy for an x402 payer: it may sign EIP-3009 transfers of the assets
 * this CLI knows about, on the chains you name, and nothing else.
 *
 * **It cannot cap an amount.** OWS's rule set is chains, typed-data contracts
 * and expiry — there is no per-signature or per-day value limit, so a policy
 * bounds *what* may be signed, never *how much*. `limits.maxPerCall` remains
 * the only amount control and it remains advisory. Saying otherwise would be
 * the same overclaim as declaring `policies: true` on a passphrase.
 */
export function buildX402Policy(input: PolicyInput): OwsPolicy {
  const chains = input.chains.map((name) => {
    const chain = findChain(name);
    if (!chain) {
      throw new X402Error(
        ExitCode.GENERIC,
        `unknown chain "${name}": known chains are ${CHAINS.map((c) => c.network).join(', ')}`,
      );
    }
    return chain;
  });
  if (chains.length === 0) {
    throw new X402Error(ExitCode.GENERIC, 'a policy needs at least one chain');
  }

  const ids = chains.map((c) => c.chainId);
  // Only the assets this CLI can actually build an authorization for. A
  // contract missing here would be refused by OWS at signing time, which is
  // the right way round: the allowlist is the narrow thing.
  const contracts = ASSETS.filter((a) => ids.includes(a.chainId)).map((a) => a.address);
  if (contracts.length === 0) {
    throw new X402Error(
      ExitCode.GENERIC,
      `no known assets on ${chains.map((c) => c.network).join(', ')}, so the policy would deny everything`,
    );
  }

  const rules: OwsPolicyRule[] = [
    { type: 'allowed_chains', chain_ids: ids.map(caip2) },
    { type: 'allowed_typed_data_contracts', contracts },
  ];
  if (input.expiresAt) rules.push({ type: 'expires_at', timestamp: input.expiresAt });

  return {
    id: input.id,
    name: input.name,
    version: 1,
    created_at: (input.now ?? new Date()).toISOString(),
    action: 'deny',
    rules,
  };
}

/** `--expires 30d` / `90d` / an ISO-8601 instant. */
export function resolveExpiry(input: string | undefined, now = new Date()): string | undefined {
  if (!input) return undefined;
  const relative = /^(\d+)([dhw])$/.exec(input.trim());
  if (relative) {
    const amount = Number(relative[1]);
    // SAFETY: the regex above matched exactly one of d, h or w, so the index is
    // one of the three keys; the `?? 24` covers the impossible case anyway.
    const unitHours = { h: 1, d: 24, w: 168 }[relative[2] as 'h' | 'd' | 'w'] ?? 24;
    return new Date(now.getTime() + amount * unitHours * 3_600_000).toISOString();
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new X402Error(
      ExitCode.GENERIC,
      `--expires "${input}" is neither a duration (30d, 12h, 2w) nor an ISO-8601 instant`,
    );
  }
  return parsed.toISOString();
}

export interface PolicyGrant {
  policy: OwsPolicy;
  keyId: string;
  keyName: string;
  /** Shown once by OWS and never retrievable again. Never written to config. */
  token: string;
}

export interface GrantOptions {
  wallet: string;
  policyName?: string;
  chains: string[];
  expires?: string;
  vaultPath?: string;
  /** The vault passphrase; OWS needs it to bind the key to the wallet. */
  passphrase?: string;
  now?: Date;
}

/**
 * Register the policy and mint an API key bound to it, both through the OWS
 * bindings rather than the `ows` CLI — same vault, one fewer moving part, and
 * the token comes back as a value instead of being scraped from stdout.
 */
export async function grantPolicyKey(
  opts: GrantOptions,
  load: () => Promise<OwsCoreModule> = loadOwsCore,
): Promise<PolicyGrant> {
  const ows = await load();
  const id = opts.policyName ?? `x402-${opts.wallet}`;
  const policy = buildX402Policy({
    id,
    name: `x402 payer: ${opts.chains.join(', ')}`,
    chains: opts.chains,
    ...(opts.expires ? { expiresAt: resolveExpiry(opts.expires, opts.now) ?? '' } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  try {
    ows.createPolicy(JSON.stringify(policy), opts.vaultPath);
  } catch (err) {
    // Re-registering the same id is the common re-run, not a failure.
    // SAFETY: `.message` off a non-Error is `undefined`, and `??` falls back to
    // the stringified value rather than losing the reason.
    const message = (err as Error).message ?? String(err);
    if (!/exists|duplicate/i.test(message)) {
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        `ows-core could not register a policy: ${message}`,
      );
    }
  }

  let key: { token: string; id: string; name: string };
  try {
    key = ows.createApiKey(
      `x402-${opts.wallet}`,
      [opts.wallet],
      [id],
      opts.passphrase ?? '',
      opts.expires ? resolveExpiry(opts.expires, opts.now) : undefined,
      opts.vaultPath,
    );
  } catch (err) {
    // SAFETY: as above — `.message` off a non-Error is `undefined`, not a throw.
    const message = (err as Error).message ?? String(err);
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `ows-core could not create an API key: ${message}. The vault passphrase must be the ` +
        'one this wallet was created with — OWS needs it to bind the key.',
    );
  }

  return { policy, keyId: key.id, keyName: key.name, token: key.token };
}
