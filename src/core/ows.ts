import { X402Error, ExitCode } from './errors.js';
import { request, parseJsonBody } from './http.js';
import type { TypedData } from './eip3009.js';
import type { SignerAccount, SignerBackend, SignerBalance, SignerCapabilities } from './signer.js';

/**
 * Client for the Open Wallet Standard agent access layer.
 *
 * All signing goes through here. The CLI holds an OWS API key scoped to a
 * single wallet, with policies attached on the OWS side. There is deliberately
 * no fallback signing path: if OWS denies, the call fails.
 */
export interface OwsWallet {
  id: string;
  name?: string;
  address: string;
  chains?: string[];
}

export interface OwsBalance {
  asset: string;
  chain?: string;
  /** Human decimal amount. */
  amount: string;
  decimals?: number;
}

export interface OwsClientOptions {
  endpoint: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function owsErrorText(body: unknown, status: number): string {
  if (isObj(body)) {
    const msg = body.error ?? body.message ?? body.detail;
    if (typeof msg === 'string') return msg;
    if (isObj(msg) && typeof msg.message === 'string') return msg.message;
  }
  return `HTTP ${status}`;
}

/** Map an OWS failure onto the CLI's exit-code taxonomy. */
export function mapOwsError(status: number, body: unknown, endpoint: string): X402Error {
  const text = owsErrorText(body, status);
  const lowered = text.toLowerCase();
  const code = isObj(body) && typeof body.code === 'string' ? body.code.toLowerCase() : '';

  if (/insufficient|balance/.test(lowered) || code.includes('insufficient')) {
    return new X402Error(ExitCode.INSUFFICIENT_BALANCE, `wallet balance insufficient: ${text}`);
  }
  if (
    status === 403 ||
    /polic|denied|not permitted|forbidden|limit/.test(lowered) ||
    code.includes('policy')
  ) {
    return new X402Error(ExitCode.POLICY_DENIED, `OWS policy denied the signature: ${text}`);
  }
  if (status === 401 || status === 407 || /auth|api key|token/.test(lowered)) {
    return new X402Error(ExitCode.OWS_UNREACHABLE, `OWS auth failed at ${endpoint}: ${text}`);
  }
  if (status === 404 || status === 405 || status === 501) {
    return new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `OWS at ${endpoint} does not implement this method (${text}). ` +
        `EIP-3009 needs EIP-712 typed-data signing; see docs/ows.md.`,
    );
  }
  return new X402Error(ExitCode.OWS_UNREACHABLE, `OWS error at ${endpoint}: ${text}`);
}

/**
 * The hint that saves an hour.
 *
 * This backend speaks HTTP to an OWS service. `@open-wallet-standard/core`
 * ships **no** daemon, so on a machine where only that package is installed
 * nothing is listening and nothing ever will be — and the honest next step is
 * not "start the daemon" but "use the backend that needs none". Without this,
 * a connection refused on loopback reads as a service that failed to start,
 * and the reasonable response is to go looking for it.
 */
export function noDaemonHint(endpoint: string): string {
  let loopback = false;
  try {
    const host = new URL(endpoint).hostname;
    loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    // An unparseable endpoint is its own problem; say nothing extra about it.
    return '';
  }
  if (!loopback) return '';
  return (
    '. Nothing is listening there. `@open-wallet-standard/core` ships no daemon, ' +
    'so if that is what you installed, there is none to start: switch to the ' +
    'in-process backend with `rh-x402 config set wallet.backend ows-core` ' +
    '(or `rh-x402 wallet create --path ows`), which talks to the same vault ' +
    'without a service. This backend is for a separate OWS HTTP service.'
  );
}

export class OwsClient {
  readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: OwsClientOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers = this.headers();
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await request({
        url: `${this.endpoint}${path}`,
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      // SAFETY: `.message` off a non-Error is `undefined`, not a throw.
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        `OWS unreachable at ${this.endpoint}: ${(err as Error).message}` +
          noDaemonHint(this.endpoint),
      );
    }
    const parsed = parseJsonBody(res.body);
    if (res.status >= 400) throw mapOwsError(res.status, parsed, this.endpoint);
    return parsed;
  }

  async listWallets(): Promise<OwsWallet[]> {
    const body = await this.call('GET', '/v1/wallets');
    const items = Array.isArray(body)
      ? body
      : isObj(body) && Array.isArray(body.wallets)
        ? body.wallets
        : [];
    return items.filter(isObj).map((w) => ({
      id: String(w.id ?? w.name ?? ''),
      name: typeof w.name === 'string' ? w.name : undefined,
      address: String(w.address ?? ''),
      chains: Array.isArray(w.chains) ? w.chains.map(String) : undefined,
    }));
  }

  async getWallet(wallet: string): Promise<OwsWallet> {
    const body = await this.call('GET', `/v1/wallets/${encodeURIComponent(wallet)}`);
    if (!isObj(body) || typeof body.address !== 'string') {
      throw new X402Error(ExitCode.OWS_UNREACHABLE, `OWS returned no address for wallet ${wallet}`);
    }
    return {
      id: String(body.id ?? wallet),
      name: typeof body.name === 'string' ? body.name : undefined,
      address: body.address,
      chains: Array.isArray(body.chains) ? body.chains.map(String) : undefined,
    };
  }

  async balance(wallet: string, asset: string, chain: string): Promise<OwsBalance | undefined> {
    const query = `?asset=${encodeURIComponent(asset)}&chain=${encodeURIComponent(chain)}`;
    const body = await this.call(
      'GET',
      `/v1/wallets/${encodeURIComponent(wallet)}/balance${query}`,
    );
    if (!isObj(body)) return undefined;
    const amount = body.amount ?? body.balance ?? body.value;
    if (amount === undefined) return undefined;
    return {
      asset: String(body.asset ?? asset),
      chain: String(body.chain ?? chain),
      amount: String(amount),
      decimals: typeof body.decimals === 'number' ? body.decimals : undefined,
    };
  }

  /**
   * EIP-712 typed-data signature. This is the one OWS capability the whole tool
   * depends on; `signMessage` cannot substitute for it.
   */
  async signTypedData(wallet: string, typedData: TypedData): Promise<string> {
    const body = await this.call(
      'POST',
      `/v1/wallets/${encodeURIComponent(wallet)}/sign-typed-data`,
      {
        typedData,
      },
    );
    const signature = isObj(body) ? (body.signature ?? body.result ?? body.data) : undefined;
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      throw new X402Error(ExitCode.OWS_UNREACHABLE, 'OWS returned no signature for signTypedData');
    }
    return signature;
  }

  /**
   * Ask OWS what it can do. A backend that does not implement capability
   * discovery returns undefined, and support is assumed rather than declared.
   */
  async capabilities(): Promise<{ typedData: boolean; policies: boolean } | undefined> {
    try {
      const body = await this.call('GET', '/v1/capabilities');
      if (!isObj(body)) return undefined;
      const methods = Array.isArray(body.methods) ? body.methods.map(String) : [];
      const typedData =
        body.typedData === true ||
        body.signTypedData === true ||
        methods.includes('signTypedData') ||
        methods.includes('sign-typed-data');
      return { typedData, policies: body.policies === true || Array.isArray(body.policies) };
    } catch {
      return undefined;
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.call('GET', '/v1/wallets');
      return { ok: true, detail: 'reachable' };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

/** The reference backend: API-key auth, policy-gated signing. */
export class OwsSigner implements SignerBackend {
  readonly backend = 'ows';
  private caps: SignerCapabilities | undefined;

  constructor(
    private readonly client: OwsClient,
    readonly wallet: string,
  ) {}

  async capabilities(): Promise<SignerCapabilities> {
    if (this.caps) return this.caps;
    const declared = await this.client.capabilities();
    this.caps = declared
      ? { ...declared, balances: true, accounts: true, declared: true }
      : // OWS does not advertise capabilities yet, so typed-data support is
        // assumed and a missing method surfaces as exit 47 at signing time.
        { typedData: true, policies: true, balances: true, accounts: true, declared: false };
    return this.caps;
  }

  async getAccounts(): Promise<SignerAccount[]> {
    return (await this.client.listWallets()).map((w) => ({
      id: w.name ?? w.id,
      address: w.address,
      chains: w.chains,
    }));
  }

  async getAddress(): Promise<string> {
    return (await this.client.getWallet(this.wallet)).address;
  }

  async signTypedData(typedData: TypedData): Promise<string> {
    return this.client.signTypedData(this.wallet, typedData);
  }

  async getBalance(asset: string, chain: string): Promise<SignerBalance | undefined> {
    try {
      return await this.client.balance(this.wallet, asset, chain);
    } catch {
      return undefined;
    }
  }
}
