import { X402Error, ExitCode, exitCodeOf, messageOf } from './errors.js';
import { request, parseJsonBody, type HeaderMap, type HttpResponse } from './http.js';
import { isJsonObject, isString, type JsonObject, type JsonValue } from './json.js';
import { toQueryParams, topLevelKeys } from './data.js';
import {
  assertSupportedVersion,
  parsePaymentRequired,
  requirementsFromHeaders,
  selectOption,
  type PaymentOption,
  type PaymentRequired,
} from './x402.js';
import {
  buildAuthorization,
  buildPaymentPayload,
  encodePaymentHeader,
  paymentHeaderName,
  settlementFromHeaders,
  type SettlementResponse,
  type TypedData,
} from './eip3009.js';
import { authKey, readAuth, writeAuth, pruneAuthCache, type AuthCacheEntry } from './authcache.js';
import { runGates, SessionBudget } from './gates.js';
import { appendRecord, readRecords, spentToday, type LedgerRecord } from './ledger.js';
import { agentContext, summarizeHeaders, summarizePayload, TelemetrySink } from './telemetry.js';
import { resolveTarget, type Provider } from './discover.js';
import { parseUnits, formatUnits } from './assets.js';
import { ulid, tagged } from './ids.js';
import type { PayloadLevel, X402Config } from './config.js';
import type { SignerBackend, SignerFactory } from './signer.js';

export interface CallOptions {
  /** Absolute URL or `x402:<capability>`. */
  target: string;
  method?: string | undefined;
  data?: JsonValue | undefined;
  headers?: HeaderMap;
  timeoutSeconds?: number | undefined;
  /** Per-call cap, human decimal. Overrides config `limits.maxPerCall`. */
  max?: string | undefined;
  /** Acceptable chains. Defaults to config `defaults.chain`. */
  chains?: string[] | undefined;
  dryRun?: boolean;
  noCache?: boolean;
  form?: boolean;
  bodyAlways?: boolean;
  payloadLevel?: PayloadLevel | undefined;
  /** Wallet within the signer backend. Defaults to config `wallet.default`. */
  wallet?: string | undefined;
  /** Signer backend for this call. Defaults to config `wallet.backend`. */
  signer?: string | undefined;
  /** Caller identity recorded in the ledger `agent` block (serve tokens). */
  agentToken?: string | undefined;
  /** Explicit body, bypassing data placement. */
  rawBody?: string | undefined;
}

/**
 * How far a payment actually got.
 *
 * `paid: true` on a call the provider then rejected is the report an agent
 * cannot act on: it cannot tell "money moved and the response was lost" from
 * "nothing moved". These four states say which.
 *
 * - `none`      nothing was signed.
 * - `signed`    an authorization exists but no settlement can follow it: the
 *               provider rejected it, so nothing moved.
 * - `submitted` the authorization reached the provider and was not rejected.
 *               Money has very likely moved; a provider that returns no
 *               settlement receipt never lets the client do better than this.
 * - `settled`   a settlement receipt confirms the transfer.
 *
 * `paid` stays `submitted || settled`. It is deliberately *not* reserved for
 * `settled`: the ledger's daily cap counts `paid` records, and most providers
 * return no settlement header at all, so a settled-only `paid` would under-count
 * real spend and quietly disarm the cap.
 */
export type PaymentState = 'none' | 'signed' | 'submitted' | 'settled';

/** Whether a state means the wallet should be assumed to have spent. */
export const isSpent = (state: PaymentState): boolean =>
  state === 'submitted' || state === 'settled';

export interface Receipt {
  id: string;
  ts: string;
  url: string;
  method: string;
  wallet: string;
  backend: string;
  scheme: string;
  network: string;
  chain: string;
  asset: string;
  assetSymbol: string;
  amount: string;
  amountAtomic: string;
  payTo: string;
  from: string;
  nonce: string;
  validBefore: number;
  authHash: string;
  cacheHit: boolean;
  settlement?: SettlementResponse | undefined;
  status: number | null;
  /** Protocol version the payment was constructed for. */
  x402Version: number;
  state: PaymentState;
}

export interface CallResult {
  ok: boolean;
  status: number | null;
  /** True once the authorization left this process and was not rejected. */
  paid: boolean;
  /** The honest detail behind `paid`. See {@link PaymentState}. */
  paymentState: PaymentState;
  amount: string;
  asset?: string | undefined;
  receiptId: string;
  body?: JsonValue | undefined;
  rawBody?: string;
  headers?: Record<string, string>;
  provider?: Provider | undefined;
  capability?: string | undefined;
  url: string;
  requirements?: PaymentRequired | undefined;
  selected?: PaymentOption | undefined;
  receipt?: Receipt | undefined;
  record: LedgerRecord;
  cacheHit?: boolean;
  dryRun?: boolean;
  errorCode?: number;
  error?: string;
  /** The {@link X402Error.detail} of the failure, when it carried one. */
  detail?: JsonObject;
}

export interface EngineDeps {
  config: X402Config;
  /** Lazily resolved so a free call never touches the wallet layer. */
  signer: SignerFactory;
  sink?: TelemetrySink | undefined;
  budget?: SessionBudget | undefined;
  /** Wallet label recorded in the ledger. */
  walletName?: string | undefined;
  /** Backend label recorded in the ledger. */
  backendName?: string | undefined;
  now?: () => number;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Method inference: no data -> GET; any data -> POST unless told otherwise. */
export function inferMethod(data: JsonValue | undefined, explicit?: string): string {
  if (explicit) return explicit.toUpperCase();
  return data === undefined ? 'GET' : 'POST';
}

export interface PreparedRequest {
  url: string;
  method: string;
  headers: HeaderMap;
  body: string | undefined;
}

/**
 * The request the response actually answered, after same-origin redirects.
 *
 * A 301/302/303 of a POST becomes a GET and drops the body, the same way
 * `fetch` would. The paid retry has to repeat that request, or it pays for a
 * different one than the quote was for.
 */
function requestThatLanded(prepared: PreparedRequest, res: HttpResponse): PreparedRequest {
  const method = res.method.toUpperCase();
  if (res.url === prepared.url && method === prepared.method.toUpperCase()) return prepared;
  if (method === 'GET' || method === 'HEAD') {
    const headers: HeaderMap = {};
    for (const [name, value] of Object.entries(prepared.headers)) {
      const lower = name.toLowerCase();
      if (lower === 'content-type' || lower === 'content-length' || lower === 'transfer-encoding') {
        continue;
      }
      headers[name] = value;
    }
    return { url: res.url, method, headers, body: undefined };
  }
  return { ...prepared, url: res.url, method };
}

export interface PlacementOptions {
  method?: string | undefined;
  headers?: HeaderMap;
  form?: boolean;
  bodyAlways?: boolean;
  rawBody?: string | undefined;
}

/** Apply the placement rules from spec 4.3. */
export function prepareRequest(
  target: string,
  data: JsonValue | undefined,
  opts: PlacementOptions = {},
): PreparedRequest {
  const method = inferMethod(data, opts.method);
  const headers: HeaderMap = { accept: 'application/json', ...opts.headers };
  let url: string;
  try {
    url = new URL(target).toString();
  } catch {
    throw new X402Error(ExitCode.GENERIC, `not a valid URL: ${target}`);
  }
  let body: string | undefined = opts.rawBody;

  if (body === undefined && data !== undefined) {
    const wantsBody = BODY_METHODS.has(method) || opts.bodyAlways === true;
    if (!wantsBody) {
      const parsed = new URL(url);
      for (const [k, v] of toQueryParams(data)) parsed.searchParams.append(k, v);
      url = parsed.toString();
    } else if (opts.form) {
      const form = new URLSearchParams();
      for (const [k, v] of toQueryParams(data)) form.append(k, v);
      body = form.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (isString(data)) {
      body = data;
      headers['content-type'] ??= 'text/plain';
    } else {
      body = JSON.stringify(data);
      headers['content-type'] = 'application/json';
    }
  }

  return { url, method, headers, body };
}

/**
 * Why the provider rejected a payment, in its own words.
 *
 * The client's own "provider rejected the payment authorization" is the least
 * useful sentence available: the provider usually says something actionable
 * ("Upgrade to x402 v2", "authorization expired") in the settlement receipt,
 * in a fresh 402's `error`, or in the body. Pass it through rather than
 * flattening it, capped so a large error page cannot flood the ledger.
 */
const REJECTION_BODY_LIMIT = 300;

export function providerRejection(
  res: HttpResponse,
  settlement: SettlementResponse | undefined,
): string {
  const reasons: string[] = [];
  if (settlement?.errorReason) reasons.push(settlement.errorReason);

  // A v2 provider re-states the requirements on the second 402, and puts the
  // reason the first payment failed in their `error` field.
  try {
    const fresh = requirementsFromHeaders(res.headers);
    const err = isJsonObject(fresh) ? fresh.error : undefined;
    if (isString(err) && err !== '') reasons.push(err);
  } catch {
    // A malformed header is not worth failing the error message over.
  }

  const body = parseJsonBody(res.body);
  if (isJsonObject(body)) {
    for (const value of [body.error, body.message]) {
      if (isString(value) && value !== '') reasons.push(value);
    }
  }
  if (reasons.length === 0 && res.body.trim() !== '') {
    reasons.push(res.body.trim().slice(0, REJECTION_BODY_LIMIT));
  }

  const unique = [...new Set(reasons.map((r) => r.slice(0, REJECTION_BODY_LIMIT)))];
  if (unique.length === 0) return 'provider rejected the payment authorization';
  return `provider rejected the payment authorization: ${unique.join(' | ')}`;
}

export class Engine {
  private readonly config: X402Config;
  private readonly deps: EngineDeps;
  /** One signing queue per backend and wallet, so concurrent callers share one authorization. */
  private readonly signQueues = new Map<string, Promise<unknown>>();

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.config = deps.config;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Resolve a signer without paying anything. Used by health checks. */
  async signerFor(selector: { backend?: string; wallet?: string } = {}): Promise<SignerBackend> {
    return this.deps.signer(selector);
  }

  private payloadLevel(override?: PayloadLevel): PayloadLevel {
    return override ?? this.config.telemetry.payload;
  }

  /** Fetch and parse the 402 requirements without paying. */
  async probe(opts: CallOptions): Promise<{
    url: string;
    status: number;
    requirements?: PaymentRequired;
    selected?: PaymentOption;
    provider?: Provider;
    capability?: string;
    body?: JsonValue;
  }> {
    const resolved = await resolveTarget(opts.target, this.config);
    const prepared = prepareRequest(resolved.url, opts.data, opts);
    const res = await request({
      ...prepared,
      timeoutMs: (opts.timeoutSeconds ?? this.config.defaults.timeout) * 1000,
      allowDomains: this.config.allowlist.domains,
    });
    if (res.status !== 402) {
      return {
        url: res.url,
        status: res.status,
        provider: resolved.provider,
        capability: resolved.capability,
        body: parseJsonBody(res.body) ?? res.body,
      };
    }
    const requirements = parsePaymentRequired(
      requirementsFromHeaders(res.headers) ?? parseJsonBody(res.body) ?? res.body,
    );
    const selected = selectOption(requirements, {
      chains: opts.chains ?? [this.config.defaults.chain],
      preferChain: this.config.defaults.chain,
    });
    return {
      url: res.url,
      status: res.status,
      requirements,
      selected,
      provider: resolved.provider,
      capability: resolved.capability,
    };
  }

  /** The whole loop: request, 402, gate, sign, retry, record. */
  async call(opts: CallOptions): Promise<CallResult> {
    const id = ulid(this.now());
    const startedAt = this.now();
    const level = this.payloadLevel(opts.payloadLevel);
    const agent = agentContext();
    if (opts.agentToken) agent.token = opts.agentToken;

    let resolved: Awaited<ReturnType<typeof resolveTarget>>;
    let prepared: PreparedRequest;
    try {
      resolved = await resolveTarget(opts.target, this.config);
      prepared = prepareRequest(resolved.url, opts.data, opts);
    } catch (err) {
      const record = this.baseRecord({
        id,
        url: opts.target,
        method: opts.method ?? 'GET',
        agent,
        level,
      });
      record.exitCode = exitCodeOf(err);
      record.error = messageOf(err);
      record.response.latencyMs = this.now() - startedAt;
      this.commit(record);
      return this.errorResult(record, err);
    }

    const timeoutMs = (opts.timeoutSeconds ?? this.config.defaults.timeout) * 1000;
    const allowDomains = this.config.allowlist.domains;
    const record = this.baseRecord({
      id,
      url: prepared.url,
      method: prepared.method,
      agent,
      level,
      data: opts.data,
      body: prepared.body,
      headers: prepared.headers,
      capability: resolved.capability,
      provider: resolved.provider?.url,
    });

    // 1. Unpaid attempt.
    let first: HttpResponse;
    try {
      first = await request({ ...prepared, timeoutMs, allowDomains });
    } catch (err) {
      record.exitCode = exitCodeOf(err);
      record.error = messageOf(err);
      record.response.latencyMs = this.now() - startedAt;
      this.commit(record);
      return this.errorResult(record, err);
    }

    // Same-origin redirects are already followed. Pay, gate and cache against
    // the URL that actually answered, which is the only one a payment may name.
    prepared = requestThatLanded(prepared, first);
    record.url = prepared.url;
    record.method = prepared.method;

    // 2. Not a 402: done, logged with amount 0.
    if (first.status !== 402) {
      this.recordResponse(record, first, level);
      record.exitCode = first.status >= 200 && first.status < 400 ? ExitCode.OK : ExitCode.GENERIC;
      record.response.latencyMs = this.now() - startedAt;
      this.commit(record);
      const body = parseJsonBody(first.body);
      const result: CallResult = {
        ok: record.exitCode === ExitCode.OK,
        status: first.status,
        paid: false,
        paymentState: 'none',
        amount: '0',
        receiptId: id,
        body: body ?? first.body,
        rawBody: first.body,
        headers: first.headers,
        url: prepared.url,
        provider: resolved.provider,
        capability: resolved.capability,
        record,
      };
      if (record.exitCode !== ExitCode.OK) {
        result.errorCode = record.exitCode;
        result.error = `upstream returned HTTP ${first.status}`;
      }
      return result;
    }

    // 3. Parse requirements and select an option.
    let requirements: PaymentRequired;
    let option: PaymentOption;
    try {
      requirements = parsePaymentRequired(
        requirementsFromHeaders(first.headers) ?? parseJsonBody(first.body) ?? first.body,
      );
      option = selectOption(requirements, {
        chains: opts.chains ?? [this.config.defaults.chain],
        preferChain: this.config.defaults.chain,
      });
      // Before the gates, and well before signing: an authorization this build
      // cannot address correctly is money at risk on a call that cannot succeed.
      assertSupportedVersion(requirements.x402Version);
    } catch (err) {
      record.exitCode = exitCodeOf(err);
      record.error = messageOf(err);
      record.response.status = 402;
      record.response.latencyMs = this.now() - startedAt;
      this.commit(record);
      return this.errorResult(record, err);
    }

    record.payment.asset = option.assetSymbol;
    record.payment.chain = option.chain;
    record.payment.payTo = option.payTo;
    record.payment.scheme = option.scheme;
    record.payment.amount = option.amount;

    // 4. Gates, in order.
    try {
      this.gate(option, prepared.url, opts);
    } catch (err) {
      record.payment.paid = false;
      record.payment.amount = '0';
      record.exitCode = exitCodeOf(err);
      record.error = messageOf(err);
      record.response.status = 402;
      record.response.latencyMs = this.now() - startedAt;
      this.commit(record);
      return { ...this.errorResult(record, err), requirements, selected: option };
    }

    if (opts.dryRun) {
      record.payment.paid = false;
      record.payment.amount = '0';
      record.exitCode = ExitCode.OK;
      record.response.status = 402;
      record.response.latencyMs = this.now() - startedAt;
      this.commit(record);
      return {
        ok: true,
        status: 402,
        paid: false,
        paymentState: 'none',
        amount: option.amount,
        asset: option.assetSymbol,
        receiptId: id,
        url: prepared.url,
        requirements,
        selected: option,
        provider: resolved.provider,
        capability: resolved.capability,
        dryRun: true,
        record,
      };
    }

    // 5. Sign (or reuse a cached authorization).
    let auth: AuthCacheEntry & { cacheHit?: boolean };
    const signStarted = this.now();
    try {
      auth = await this.authorize(option, prepared, opts, requirements);
    } catch (err) {
      record.payment.paid = false;
      record.payment.amount = '0';
      record.exitCode = exitCodeOf(err);
      record.error = messageOf(err);
      record.response.status = 402;
      record.response.latencyMs = this.now() - startedAt;
      this.commit(record);
      return { ...this.errorResult(record, err), requirements, selected: option };
    }

    // Signed, not yet sent: nothing has moved and nothing can until the retry.
    record.payment.state = 'signed';
    record.payment.paid = false;
    record.payment.x402Version = auth.x402Version;
    record.payment.authHash = tagged(auth.signature);
    record.payment.cacheHit = auth.cacheHit === true;
    record.wallet = auth.wallet;
    record.backend = auth.backend;
    const paymentLatencyMs = this.now() - signStarted;

    // 6. Paid retry.
    // v1 sends `X-PAYMENT`; v2 sends `PAYMENT-SIGNATURE`. Providers on the
    // current index reject the wrong one outright.
    const paidHeaders = { ...prepared.headers, [auth.headerName]: auth.header };
    let second: HttpResponse;
    try {
      second = await request({ ...prepared, headers: paidHeaders, timeoutMs, allowDomains });
    } catch (err) {
      // The authorization may already be settled: log the receipt, exit 50, and
      // keep the cache entry so a re-run reuses it instead of paying twice.
      record.exitCode = ExitCode.PAID_NO_RESPONSE;
      record.error = messageOf(err);
      // The authorization left this process; assume it may have settled.
      record.payment.state = 'submitted';
      record.payment.paid = true;
      record.payment.amount = option.amount;
      record.response.paymentLatencyMs = paymentLatencyMs;
      record.response.latencyMs = this.now() - startedAt;
      this.commit(record);
      const receipt = this.receipt(id, auth, option, null, undefined, 'submitted');
      return {
        ok: false,
        status: null,
        paid: true,
        paymentState: 'submitted',
        amount: option.amount,
        asset: option.assetSymbol,
        receiptId: id,
        url: prepared.url,
        requirements,
        selected: option,
        receipt,
        provider: resolved.provider,
        capability: resolved.capability,
        cacheHit: record.payment.cacheHit,
        record,
        errorCode: ExitCode.PAID_NO_RESPONSE,
        error: messageOf(err),
      };
    }

    const settlement = settlementFromHeaders(second.headers);
    record.payment.settlement = settlement;
    this.recordResponse(record, second, level);
    record.response.paymentLatencyMs = paymentLatencyMs;
    record.response.latencyMs = this.now() - startedAt;

    if (second.status === 402) {
      // Provider rejected the authorization: it was signed, but nothing settled
      // against it, so the wallet is untouched — `signed`, not `paid`.
      //
      // The cache entry is deliberately kept. A rejected authorization is still
      // a live EIP-3009 signature until its `validBefore`, and the provider
      // holds it; signing a fresh one with a new nonce is the only way two
      // transfers can happen. Reusing the entry on a retry keeps the worst case
      // at one. See docs/idempotency.md.
      const rejectedSettled = settlement?.success === true;
      const state: PaymentState = rejectedSettled ? 'settled' : 'signed';
      record.payment.state = state;
      record.payment.paid = isSpent(state);
      record.payment.amount = isSpent(state) ? option.amount : '0';
      record.exitCode = ExitCode.INVALID_402;
      record.error = providerRejection(second, settlement);
      this.commit(record);
      return {
        ok: false,
        status: 402,
        paid: isSpent(state),
        paymentState: state,
        amount: isSpent(state) ? option.amount : '0',
        asset: option.assetSymbol,
        receiptId: id,
        url: prepared.url,
        requirements,
        selected: option,
        receipt: this.receipt(id, auth, option, 402, settlement, state),
        record,
        errorCode: ExitCode.INVALID_402,
        error: record.error,
      };
    }

    const httpOk = second.status >= 200 && second.status < 400;
    // A settlement receipt is the only proof the transfer happened; without one
    // the honest answer is that the authorization was submitted and accepted.
    const state: PaymentState = settlement?.success === true ? 'settled' : 'submitted';
    record.payment.state = state;
    record.payment.paid = true;
    record.payment.amount = option.amount;
    record.exitCode = httpOk ? ExitCode.OK : ExitCode.PAID_NO_RESPONSE;
    if (!httpOk) record.error = `paid, but upstream returned HTTP ${second.status}`;
    this.deps.budget?.record(option.amountAtomic);
    this.commit(record);

    const body = parseJsonBody(second.body);
    const result: CallResult = {
      ok: httpOk,
      status: second.status,
      paid: true,
      paymentState: state,
      amount: option.amount,
      asset: option.assetSymbol,
      receiptId: id,
      body: body ?? second.body,
      rawBody: second.body,
      headers: second.headers,
      url: prepared.url,
      requirements,
      selected: option,
      receipt: this.receipt(id, auth, option, second.status, settlement, state),
      provider: resolved.provider,
      capability: resolved.capability,
      cacheHit: record.payment.cacheHit,
      record,
    };
    if (!httpOk) {
      result.errorCode = record.exitCode;
      if (record.error !== undefined) result.error = record.error;
    }
    return result;
  }

  private gate(option: PaymentOption, url: string, opts: CallOptions): void {
    const dailyCap = this.config.limits.dailyCap;
    let remainingDaily: bigint | undefined;
    if (dailyCap) {
      const cap = parseUnits(dailyCap, option.decimals);
      const spent = spentToday(readRecords(), option.assetSymbol, option.decimals, this.now());
      remainingDaily = cap - spent;
    }
    runGates({
      option,
      url,
      allowPayTo: this.config.allowlist.payTo,
      allowDomains: this.config.allowlist.domains,
      maxPerCall: opts.max ?? this.config.limits.maxPerCall,
      remainingBudgetAtomic: this.deps.budget?.remaining(),
      remainingDailyAtomic: remainingDaily,
    });
  }

  /**
   * Return a usable authorization, reusing the cache when possible. Signing is
   * serialised per engine so two concurrent identical calls sign once.
   */
  private async authorize(
    option: PaymentOption,
    prepared: PreparedRequest,
    opts: CallOptions,
    requirements: PaymentRequired,
  ): Promise<AuthCacheEntry & { cacheHit?: boolean }> {
    const signer = await this.deps.signer({ backend: opts.signer, wallet: opts.wallet });
    const queueKey = `${signer.backend}:${signer.wallet}`;
    const previous = this.signQueues.get(queueKey) ?? Promise.resolve();

    const run = previous.then(async () => {
      const from = await signer.getAddress();
      const key = authKey({
        url: prepared.url,
        method: prepared.method,
        body: prepared.body ?? '',
        payTo: option.payTo,
        amountAtomic: option.amountAtomic,
        asset: option.asset,
        chain: option.chain,
        wallet: signer.wallet,
        backend: signer.backend,
        // A v1 header cannot be replayed against a v2 provider (different
        // payload shape, different header), so the version is part of the
        // request identity rather than something a cache hit can paper over.
        x402Version: requirements.x402Version,
      });

      if (!opts.noCache) {
        const cached = readAuth(key, this.now());
        if (cached) return { ...cached, cacheHit: true };
      }

      await this.assertBalance(signer, option);

      const built = buildAuthorization({
        option,
        from,
        now: Math.floor(this.now() / 1000),
      });
      const signature = await signer.signTypedData(built.typedData);
      const payload = buildPaymentPayload(option, built.typedData, signature, {
        x402Version: requirements.x402Version,
        resource: requirements.resource,
        extensions: requirements.extensions,
      });
      const entry: AuthCacheEntry = {
        key,
        url: prepared.url,
        method: prepared.method,
        wallet: signer.wallet,
        backend: signer.backend,
        payTo: option.payTo,
        amountAtomic: option.amountAtomic.toString(),
        asset: option.asset,
        chain: option.chain,
        scheme: option.scheme,
        network: option.network,
        nonce: built.nonce,
        validBefore: built.validBefore,
        signature,
        typedData: built.typedData,
        x402Version: requirements.x402Version,
        headerName: paymentHeaderName(requirements.x402Version),
        header: encodePaymentHeader(payload),
        createdAt: new Date(this.now()).toISOString(),
      };
      if (!opts.noCache) writeAuth(entry);
      try {
        pruneAuthCache(this.now());
      } catch {
        /* pruning is best effort */
      }
      return { ...entry, cacheHit: false };
    });
    this.signQueues.set(
      queueKey,
      run.catch(() => undefined),
    );
    return run;
  }

  private async assertBalance(signer: SignerBackend, option: PaymentOption): Promise<void> {
    if (!signer.getBalance) return;
    const balance = await signer.getBalance(option.asset, option.chain);
    if (!balance) return;
    let atomic: bigint;
    try {
      atomic = parseUnits(balance.amount, balance.decimals ?? option.decimals);
    } catch {
      return;
    }
    if (atomic < option.amountAtomic) {
      throw new X402Error(
        ExitCode.INSUFFICIENT_BALANCE,
        `wallet holds ${formatUnits(atomic, option.decimals)} ${option.assetSymbol}, needs ${option.amount}`,
      );
    }
  }

  private receipt(
    id: string,
    auth: AuthCacheEntry & { cacheHit?: boolean },
    option: PaymentOption,
    status: number | null,
    settlement: SettlementResponse | undefined,
    state: PaymentState,
  ): Receipt {
    return {
      id,
      ts: new Date(this.now()).toISOString(),
      url: auth.url,
      method: auth.method,
      wallet: auth.wallet,
      backend: auth.backend,
      scheme: option.scheme,
      network: option.network,
      chain: option.chain,
      asset: option.asset,
      assetSymbol: option.assetSymbol,
      amount: option.amount,
      amountAtomic: option.amountAtomic.toString(),
      payTo: option.payTo,
      from: auth.typedData.message.from,
      nonce: auth.nonce,
      validBefore: auth.validBefore,
      authHash: tagged(auth.signature),
      cacheHit: auth.cacheHit === true,
      settlement,
      status,
      x402Version: auth.x402Version,
      state,
    };
  }

  private baseRecord(args: {
    id: string;
    url: string;
    method: string;
    agent: LedgerRecord['agent'];
    level: PayloadLevel;
    data?: JsonValue | undefined;
    body?: string | undefined;
    headers?: HeaderMap;
    capability?: string | undefined;
    provider?: string | undefined;
  }): LedgerRecord {
    const summary = summarizePayload(
      args.body ?? '',
      args.data,
      args.level,
      this.config.telemetry.redactKeys,
    );
    const request: LedgerRecord['request'] = { bytes: summary.bytes };
    if (summary.hash) request.dataHash = summary.hash;
    request.dataKeys = summary.keys ?? topLevelKeys(args.data);
    if (summary.body !== undefined) request.data = summary.body;
    if (args.headers) {
      const headerSummary = summarizeHeaders(args.headers);
      request.headerNames = headerSummary.headerNames;
      request.headersHash = headerSummary.headersHash;
    }
    const record: LedgerRecord = {
      id: args.id,
      ts: new Date(this.now()).toISOString(),
      url: args.url,
      method: args.method,
      wallet: this.deps.walletName ?? null,
      request,
      payment: { paid: false, amount: '0', state: 'none' },
      response: { status: null, bytes: 0, latencyMs: 0 },
      exitCode: ExitCode.OK,
      agent: args.agent,
    };
    if (this.deps.backendName) record.backend = this.deps.backendName;
    if (args.capability) record.capability = args.capability;
    if (args.provider) record.provider = args.provider;
    return record;
  }

  private recordResponse(record: LedgerRecord, res: HttpResponse, level: PayloadLevel): void {
    const summary = summarizePayload(
      res.body,
      parseJsonBody(res.body),
      level,
      this.config.telemetry.redactKeys,
    );
    record.response.status = res.status;
    record.response.bytes = summary.bytes;
    if (summary.hash) record.response.bodyHash = summary.hash;
    if (summary.body !== undefined) record.response.body = summary.body;
  }

  private commit(record: LedgerRecord): void {
    try {
      appendRecord(record);
    } catch (err) {
      process.stderr.write(`x402: ledger write failed: ${messageOf(err)}\n`);
    }
    this.deps.sink?.enqueue(record);
  }

  private errorResult(record: LedgerRecord, cause: unknown): CallResult {
    const result: CallResult = {
      ok: false,
      status: record.response.status,
      paid: record.payment.paid,
      paymentState: record.payment.state ?? 'none',
      amount: record.payment.amount,
      asset: record.payment.asset,
      receiptId: record.id,
      url: record.url,
      record,
      errorCode: exitCodeOf(cause),
      error: messageOf(cause),
    };
    if (cause instanceof X402Error && cause.detail) result.detail = cause.detail;
    return result;
  }
}
