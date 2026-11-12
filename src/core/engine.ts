import { X402Error, ExitCode, exitCodeOf, messageOf } from './errors.js';
import { request, parseJsonBody, type HttpResponse } from './http.js';
import { toQueryParams, topLevelKeys } from './data.js';
import {
  assertSupportedVersion,
  parsePaymentRequired,
  requirementsFromHeaders,
  selectOption,
  type ChannelCoverage,
  type PaymentOption,
  type PaymentRequired,
  type SelectOptions,
} from './x402.js';
import {
  buildAuthorization,
  buildPaymentPayload,
  encodePaymentHeader,
  paymentHeaderName,
  wrapPaymentPayload,
  settlementFromHeaders,
  type SettlementResponse,
  type PaymentPayload,
  type PaymentPayloadContext,
  type SchemePayload,
  type TypedDataDocument,
} from './eip3009.js';
import {
  authKey,
  dropAuth,
  readAuth,
  writeAuth,
  pruneAuthCache,
  type AuthCacheEntry,
} from './authcache.js';
import { runGates, SessionBudget } from './gates.js';
import { appendRecord, readRecords, spentToday, type LedgerRecord } from './ledger.js';
import { decodePaymentHeader } from './eip3009.js';
import { agentContext, summarizeHeaders, summarizePayload, TelemetrySink } from './telemetry.js';
import { resolveTarget, type Provider } from './discover.js';
import { parseUnits, formatUnits, findChain } from './assets.js';
import { rpcUrlFor } from './rpc.js';
import {
  BATCH_SETTLEMENT_SCHEME,
  buildChannelConfig,
  channelSalt,
  computeChannelId,
  depositMethodOf,
  depositPayload,
  eip3009DepositDocument,
  permit2DepositDocument,
  afterRefund,
  planChannelPayment,
  refundPayload,
  voucherDocument,
  voucherPayload,
  type ChannelPlan,
} from './channel.js';
import { AUTH_CAPTURE_SCHEME, buildAuthCapture } from './authcapture.js';
import {
  onChainReader,
  prepareChannel,
  recordChannelResponse,
  recordSigned,
  repairFromPaymentRequired,
  slotFor,
  type SentChannelPayload,
} from './channelflow.js';
import {
  deleteChannel,
  listChannels,
  lockChannel,
  readChannel,
  writeChannel,
  type ChannelRecord,
} from './channelstore.js';
import {
  AMOUNT_TOO_LOW_HINT,
  isAmountTooLow,
  quoteWarnings,
  settledAtomic,
  settlementFailure,
  settlementFromStream,
} from './settlement.js';
import {
  EIP2612_GAS_SPONSORING_KEY,
  buildEip2612Permit,
  buildUptoPermit2,
  readPermit2Allowance,
  readPermitNonce,
  type UptoSchemePayload,
} from './permit2.js';
import {
  attachPayerSignature,
  buildSvmTransaction,
  fetchLatestBlockhash,
  verifySvmTransaction,
} from './svm.js';
import { ulid, tagged } from './ids.js';
import { confirm, interactive } from './prompt.js';
import { createEvmBatchPayment } from './batchclient.js';
import type { PayloadLevel, X402Config } from './config.js';
import type { SignerBackend, SignerFactory } from './signer.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What signing a payment produces, whichever chain family it was for. */
interface SignedPayment {
  /** The EIP-3009 nonce, or the blockhash a Solana transaction is bound to. */
  nonce: string;
  /** Unix seconds after which the signed payment cannot settle. */
  validBefore: number;
  signature: string;
  typedData?: TypedDataDocument;
  payload: PaymentPayload<SchemePayload>;
}

export interface CallOptions {
  /** Absolute URL or `x402:<capability>`. */
  target: string;
  method?: string | undefined;
  data?: unknown;
  headers?: Record<string, string>;
  timeoutSeconds?: number | undefined;
  /** Per-call cap, human decimal. Overrides config `limits.maxPerCall`. */
  max?: string | undefined;
  /** Acceptable chains. Defaults to config `defaults.chain`. */
  chains?: string[] | undefined;
  /**
   * Force a scheme: `exact`, `upto`, `batch-settlement` or `auth-capture`. Absent: upto
   * where the provider offers it, else exact. The last two are never chosen unless named.
   */
  scheme?: string | undefined;
  /** `--deposit`: how much to put in a new or topped-up channel, human decimal. */
  deposit?: string | undefined;
  /** `--max-deposit`: hard ceiling on one deposit, human decimal. */
  maxDeposit?: string | undefined;
  /** `--deposit-multiplier`. Minimum 3. Default comes from config, then 5. */
  depositMultiplier?: number | undefined;
  /** `--yes`: deposit without a terminal confirmation. */
  yes?: boolean;
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
  /** What the provider reports it settled, when it says. Absent means the signed amount is the best figure. */
  settledAmount?: string | undefined;
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
  /**
   * What the signature allowed, when it differs from `amount`. An `upto` payment
   * signs a ceiling and settles what the work cost.
   */
  ceiling?: string | undefined;
  /** Things worth knowing about the quote, such as one below the facilitator minimum. */
  warnings?: string[] | undefined;
  asset?: string | undefined;
  receiptId: string;
  body?: unknown;
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
export function inferMethod(data: unknown, explicit?: string): string {
  if (explicit) return explicit.toUpperCase();
  return data === undefined ? 'GET' : 'POST';
}

export interface PreparedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Apply the placement rules from spec 4.3. */
export function prepareRequest(
  target: string,
  data: unknown,
  opts: {
    method?: string | undefined;
    headers?: Record<string, string>;
    form?: boolean;
    bodyAlways?: boolean;
    rawBody?: string | undefined;
  } = {},
): PreparedRequest {
  const method = inferMethod(data, opts.method);
  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
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
    } else if (typeof data === 'string') {
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
    const err = (fresh as { error?: unknown } | undefined)?.error;
    if (typeof err === 'string' && err !== '') reasons.push(err);
  } catch {
    // A malformed header is not worth failing the error message over.
  }

  const body = parseJsonBody(res.body) as { error?: unknown; message?: unknown } | undefined;
  // `{"error":"amount_too_low"}` and the OpenAI shape `{"error":{"code","message"}}`.
  const errorObj =
    typeof body?.error === 'object' && body.error !== null
      ? (body.error as { code?: unknown; message?: unknown })
      : undefined;
  for (const value of [
    typeof body?.error === 'string' ? body.error : undefined,
    errorObj?.code,
    errorObj?.message,
    body?.message,
  ]) {
    if (typeof value === 'string' && value !== '') reasons.push(value);
  }
  if (reasons.length === 0 && res.body.trim() !== '') {
    reasons.push(res.body.trim().slice(0, REJECTION_BODY_LIMIT));
  }

  const unique = [...new Set(reasons.map((r) => r.slice(0, REJECTION_BODY_LIMIT)))];
  if (unique.length === 0) return 'provider rejected the payment authorization';
  const hint = unique.some(isAmountTooLow) ? ` ${AMOUNT_TOO_LOW_HINT}` : '';
  return `provider rejected the payment authorization: ${unique.join(' | ')}.${hint}`;
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
    warnings?: string[];
    provider?: Provider;
    capability?: string;
    body?: unknown;
  }> {
    const resolved = await resolveTarget(opts.target, this.config);
    const prepared = prepareRequest(resolved.url, opts.data, opts);
    const res = await request({
      ...prepared,
      timeoutMs: (opts.timeoutSeconds ?? this.config.defaults.timeout) * 1000,
    });
    if (res.status !== 402) {
      return {
        url: prepared.url,
        status: res.status,
        provider: resolved.provider,
        capability: resolved.capability,
        body: parseJsonBody(res.body) ?? res.body,
      };
    }
    const requirements = parsePaymentRequired(
      requirementsFromHeaders(res.headers) ?? parseJsonBody(res.body) ?? res.body,
    );
    const selected = selectOption(requirements, this.selection(opts));
    const warnings = quoteWarnings(selected);
    return {
      url: prepared.url,
      status: res.status,
      requirements,
      selected,
      ...(warnings.length > 0 ? { warnings } : {}),
      provider: resolved.provider,
      capability: resolved.capability,
    };
  }

  /**
   * The whole loop: request, 402, gate, sign, retry, record.
   *
   * A payment channel is held for the length of the call: a voucher names a
   * cumulative amount, so two calls signing from the same state would name the
   * same number. The lock is taken after the gates pass and released here, on
   * every way out.
   */
  async call(opts: CallOptions): Promise<CallResult> {
    const hold: { release?: () => void } = {};
    try {
      return await this.callWithHold(opts, hold);
    } finally {
      hold.release?.();
    }
  }

  private async callWithHold(
    opts: CallOptions,
    hold: { release?: () => void },
  ): Promise<CallResult> {
    const id = ulid(this.now());
    const startedAt = this.now();
    const level = this.payloadLevel(opts.payloadLevel);
    const agent = { ...agentContext(), ...(opts.agentToken ? { token: opts.agentToken } : {}) };

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
      first = await request({ ...prepared, timeoutMs });
    } catch (err) {
      record.exitCode = exitCodeOf(err);
      record.error = messageOf(err);
      record.response.latencyMs = this.now() - startedAt;
      this.commit(record);
      return this.errorResult(record, err);
    }

    // 2. Not a 402: done, logged with amount 0.
    if (first.status !== 402) {
      this.recordResponse(record, first, level);
      record.exitCode = first.status >= 200 && first.status < 400 ? ExitCode.OK : ExitCode.GENERIC;
      record.response.latencyMs = this.now() - startedAt;
      this.commit(record);
      const body = parseJsonBody(first.body);
      return {
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
        ...(record.exitCode === ExitCode.OK
          ? {}
          : { errorCode: record.exitCode, error: `upstream returned HTTP ${first.status}` }),
      };
    }

    // 3. Parse requirements and select an option.
    let requirements: PaymentRequired;
    let option: PaymentOption;
    try {
      requirements = parsePaymentRequired(
        requirementsFromHeaders(first.headers) ?? parseJsonBody(first.body) ?? first.body,
      );
      option = selectOption(requirements, this.selection(opts));
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
    let plan: ChannelPlan | undefined;
    try {
      // A channel call is gated on what it moves: a deposit counts the deposit, a
      // voucher counts the request against the per-call cap and nothing more.
      plan =
        option.scheme === BATCH_SETTLEMENT_SCHEME ? this.planFromStore(option, opts) : undefined;
      this.gate(option, prepared.url, opts, plan);
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
      const dryWarnings = [...quoteWarnings(option), ...channelWarnings(plan, option)];
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
        amount:
          plan?.kind === 'deposit' ? formatUnits(plan.deposit, option.decimals) : option.amount,
        asset: option.assetSymbol,
        receiptId: id,
        url: prepared.url,
        requirements,
        selected: option,
        ...(dryWarnings.length > 0 ? { warnings: dryWarnings } : {}),
        provider: resolved.provider,
        capability: resolved.capability,
        dryRun: true,
        record,
      };
    }

    // The channel is held from here to the end of the call.
    if (option.scheme === BATCH_SETTLEMENT_SCHEME) {
      try {
        const lockSigner = await this.deps.signer({ backend: opts.signer, wallet: opts.wallet });
        hold.release = await lockChannel(
          slotFor(option, lockSigner.wallet, lockSigner.backend, channelSalt(option)),
        );
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
    let second!: HttpResponse;
    // A channel can be one voucher behind the receiver. If the receiver says so, and
    // names a total inside what this client has signed, the state is repaired and the
    // voucher re-signed once. The first attempt was refused, so nothing moved.
    for (let attempt = 1; ; attempt++) {
      const paidHeaders = { ...prepared.headers, [auth.headerName]: auth.header };
      try {
        second = await request({ ...prepared, headers: paidHeaders, timeoutMs });
      } catch (err) {
        // The authorization may already be settled: log the receipt, exit 50, and
        // keep the cache entry so a re-run reuses it instead of paying twice.
        record.exitCode = ExitCode.PAID_NO_RESPONSE;
        record.error = messageOf(err);
        // The authorization left this process; assume it may have settled.
        const movedLabel = formatUnits(exposureOf(auth, option), option.decimals);
        record.payment.state = 'submitted';
        record.payment.paid = true;
        record.payment.amount = movedLabel;
        record.response.paymentLatencyMs = paymentLatencyMs;
        record.response.latencyMs = this.now() - startedAt;
        this.commit(record);
        const receipt = this.receipt(id, auth, option, null, undefined, 'submitted');
        return {
          ok: false,
          status: null,
          paid: true,
          paymentState: 'submitted',
          amount: movedLabel,
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
      if (attempt === 1 && second.status === 402 && this.repairChannel(option, auth, second)) {
        try {
          auth = await this.authorize(option, prepared, { ...opts, noCache: true }, requirements);
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
        continue;
      }
      break;
    }

    // Headers first. A streamed response has sent them before the provider settles,
    // so its receipt is the final `x402_settlement` frame in the body.
    const settlement = settlementFromHeaders(second.headers) ?? settlementFromStream(second.body);
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

    // The provider ran the request and then could not settle. It says so in an
    // OpenAI-shaped error, and the authorization was not captured: nothing moved
    // and no response comes with it. That is not "paid, no response" (50), which
    // tells an agent to re-run the identical command. Retrying this one only has
    // the provider run the work again, so it gets its own code and its own words.
    // The cache entry stays, for the same reason it does after a 402: the
    // signature is still live at the provider, and a fresh one is the only way two
    // transfers can happen.
    const failure = settlementFailure(second.status, second.body);
    if (failure !== undefined) {
      record.payment.state = 'signed';
      record.payment.paid = false;
      record.payment.amount = '0';
      record.exitCode = ExitCode.SETTLEMENT_FAILED;
      const hint = isAmountTooLow(failure) ? ` ${AMOUNT_TOO_LOW_HINT}` : '';
      record.error = `the provider could not settle the payment, so nothing was paid and no response was returned: ${failure}${hint}`;
      this.commit(record);
      return {
        ok: false,
        status: second.status,
        paid: false,
        paymentState: 'signed',
        amount: '0',
        asset: option.assetSymbol,
        receiptId: id,
        url: prepared.url,
        requirements,
        selected: option,
        receipt: this.receipt(id, auth, option, second.status, settlement, 'signed'),
        provider: resolved.provider,
        capability: resolved.capability,
        cacheHit: record.payment.cacheHit,
        record,
        errorCode: ExitCode.SETTLEMENT_FAILED,
        error: record.error,
      };
    }

    const httpOk = second.status >= 200 && second.status < 400;
    // A settlement receipt is the only proof the transfer happened; without one
    // the honest answer is that the authorization was submitted and accepted.
    const state: PaymentState = settlement?.success === true ? 'settled' : 'submitted';
    // What left the wallet. An upto payment signs a ceiling and the provider
    // settles what the work cost, so a receipt that names an amount within the
    // signature is what the ledger and the daily cap should count. With no usable
    // figure the signed amount stands: counting less than may have moved would
    // quietly disarm the cap.
    //
    // A channel or a hold is different: a voucher draws on money already in escrow,
    // and the receipt of a hold says nothing about what the receiver will capture.
    // So a deposit counts as spent when it is sent, a voucher as nothing new, and a
    // hold as its whole maximum.
    const holdOrChannel =
      option.scheme === BATCH_SETTLEMENT_SCHEME || option.scheme === AUTH_CAPTURE_SCHEME;
    const settled = holdOrChannel ? undefined : settledAtomic(settlement, option.amountAtomic);
    const sentChannel =
      option.scheme === BATCH_SETTLEMENT_SCHEME ? decodeSent(auth, option) : undefined;
    const channelOutcome = sentChannel
      ? recordChannelResponse(
          sentChannel.slot,
          sentChannel.sent,
          settlement,
          httpOk,
          new Date(this.now()).toISOString(),
        )
      : undefined;
    // A voucher that was accepted is spent: replaying it for the next identical
    // request would name a total the receiver has already moved past.
    if (channelOutcome?.confirmed) dropAuth(auth.key);
    const paidAtomic = channelOutcome ? channelOutcome.exposure : (settled ?? option.amountAtomic);
    const paidAmount = formatUnits(paidAtomic, option.decimals);
    record.payment.state = state;
    record.payment.paid = true;
    record.payment.amount = paidAmount;
    if (paidAtomic !== option.amountAtomic) record.payment.ceiling = option.amount;
    if (sentChannel && channelOutcome) {
      record.payment.channel = {
        id: sentChannel.sent.channelId,
        kind: sentChannel.sent.kind,
        request: formatUnits(sentChannel.sent.request, option.decimals),
        ...(channelOutcome.charged !== undefined
          ? { charged: formatUnits(channelOutcome.charged, option.decimals) }
          : {}),
        ...(sentChannel.sent.deposit !== undefined
          ? { deposit: formatUnits(sentChannel.sent.deposit, option.decimals) }
          : {}),
        ...(channelOutcome.record
          ? { balance: formatUnits(BigInt(channelOutcome.record.balance), option.decimals) }
          : {}),
        ...(channelOutcome.record
          ? { cumulative: formatUnits(BigInt(channelOutcome.record.charged), option.decimals) }
          : {}),
        confirmed: channelOutcome.confirmed,
      };
    }
    record.exitCode = httpOk ? ExitCode.OK : ExitCode.PAID_NO_RESPONSE;
    if (!httpOk) record.error = `paid, but upstream returned HTTP ${second.status}`;
    this.deps.budget?.record(paidAtomic);
    this.commit(record);

    const body = parseJsonBody(second.body);
    return {
      ok: httpOk,
      status: second.status,
      paid: true,
      paymentState: state,
      amount: paidAmount,
      ...(paidAtomic !== option.amountAtomic ? { ceiling: option.amount } : {}),
      asset: option.assetSymbol,
      receiptId: id,
      body: body ?? second.body,
      rawBody: second.body,
      headers: second.headers,
      url: prepared.url,
      requirements,
      selected: option,
      receipt: this.receipt(id, auth, option, second.status, settlement, state, settled),
      provider: resolved.provider,
      capability: resolved.capability,
      cacheHit: record.payment.cacheHit,
      record,
      ...(httpOk ? {} : { errorCode: record.exitCode, error: record.error }),
    };
  }

  private gate(option: PaymentOption, url: string, opts: CallOptions, plan?: ChannelPlan): void {
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
      ...(plan ? { perCallAtomic: plan.perCallAtomic, exposureAtomic: plan.exposureAtomic } : {}),
    });
  }

  /**
   * Ask a receiver to refund what is left in a channel.
   *
   * The receiver has to expose a URL that answers 402 with a batch-settlement
   * option, which is how the reference client finds it. The refund request carries
   * a voucher for the amount charged so far, which tells the receiver the payer
   * agrees to that total, and an optional amount. Money comes back, so no cap
   * applies; the domain and payTo allowlists still do.
   */
  async refundChannel(opts: {
    target: string;
    /** Atomic units are not asked for: a human decimal in the channel's asset. Absent: everything left. */
    amount?: string | undefined;
    method?: string | undefined;
    wallet?: string | undefined;
    signer?: string | undefined;
    timeoutSeconds?: number | undefined;
  }): Promise<RefundResult> {
    const id = ulid(this.now());
    const startedAt = this.now();
    const level = this.payloadLevel(undefined);
    const resolved = await resolveTarget(opts.target, this.config);
    const prepared = prepareRequest(resolved.url, undefined, { method: opts.method });
    const record = this.baseRecord({
      id,
      url: prepared.url,
      method: prepared.method,
      agent: agentContext(),
      level,
    });
    const timeoutMs = (opts.timeoutSeconds ?? this.config.defaults.timeout) * 1000;
    const fail = (err: unknown, extra: Partial<RefundResult> = {}): RefundResult => {
      record.exitCode = exitCodeOf(err);
      record.error = messageOf(err);
      record.response.latencyMs = this.now() - startedAt;
      this.commit(record);
      return {
        ok: false,
        receiptId: id,
        url: prepared.url,
        errorCode: exitCodeOf(err),
        error: messageOf(err),
        ...extra,
      };
    };

    let release: (() => void) | undefined;
    try {
      const first = await request({ ...prepared, timeoutMs });
      if (first.status !== 402) {
        throw new X402Error(
          ExitCode.INVALID_402,
          `the refund probe expected a 402 and got HTTP ${String(first.status)}`,
        );
      }
      const requirements = parsePaymentRequired(
        requirementsFromHeaders(first.headers) ?? parseJsonBody(first.body) ?? first.body,
      );
      assertSupportedVersion(requirements.x402Version);
      const option = selectOption(requirements, {
        chains: [this.config.defaults.chain],
        preferChain: this.config.defaults.chain,
        scheme: BATCH_SETTLEMENT_SCHEME,
      });
      record.payment.scheme = option.scheme;
      record.payment.asset = option.assetSymbol;
      record.payment.chain = option.chain;
      record.payment.payTo = option.payTo;
      // Allowlists only: nothing leaves the wallet in a refund.
      runGates({
        option,
        url: prepared.url,
        allowPayTo: this.config.allowlist.payTo,
        allowDomains: this.config.allowlist.domains,
        perCallAtomic: 0n,
        exposureAtomic: 0n,
      });

      const signer = await this.deps.signer({ backend: opts.signer, wallet: opts.wallet });
      const from = await signer.getAddress(option.chain);
      const config = buildChannelConfig(option, from);
      const channelId = computeChannelId(config, option.chainId);
      const slot = slotFor(option, signer.wallet, signer.backend, config.salt);
      release = await lockChannel(slot);
      const chain = findChain(option.chain);
      const rpcUrl = chain ? rpcUrlFor(chain, this.config.rpc) : undefined;
      const rec = await prepareChannel({
        slot,
        config,
        channelId,
        option,
        wallet: signer.wallet,
        backend: signer.backend,
        url: prepared.url,
        nowSeconds: Math.floor(this.now() / 1000),
        read: rpcUrl ? onChainReader(rpcUrl) : undefined,
      });
      if (!rec) {
        throw new X402Error(
          ExitCode.GENERIC,
          'no channel is recorded for this receiver, so there is nothing to refund',
        );
      }
      if (BigInt(rec.balance) <= BigInt(rec.charged)) {
        throw new X402Error(
          ExitCode.GENERIC,
          `the channel has no balance left to refund (balance ${rec.balance}, charged ${rec.charged})`,
        );
      }
      const refundAmount =
        opts.amount === undefined ? undefined : parseUnits(opts.amount, option.decimals);
      if (refundAmount !== undefined && refundAmount <= 0n) {
        throw new X402Error(ExitCode.GENERIC, 'the refund amount must be positive');
      }

      // The voucher names the total already charged: the payer is agreeing to that
      // total and no more, which is what lets the receiver release the rest.
      const voucherDoc = voucherDocument(channelId, BigInt(rec.charged), option.chainId);
      const signature = await signer.signTypedData(voucherDoc);
      const payload = refundPayload(
        config,
        { channelId, maxClaimableAmount: rec.charged, signature },
        refundAmount?.toString(),
      );
      const wire = wrapPaymentPayload(option, payload, {
        x402Version: requirements.x402Version,
        resource: requirements.resource,
        extensions: requirements.extensions,
      });
      const res = await request({
        ...prepared,
        headers: {
          ...prepared.headers,
          [paymentHeaderName(requirements.x402Version)]: encodePaymentHeader(wire),
        },
        timeoutMs,
      });
      const settlement = settlementFromHeaders(res.headers);
      record.response.status = res.status;
      record.response.latencyMs = this.now() - startedAt;
      if (res.status === 402 || settlement?.success !== true) {
        const reason = providerRejection(res, settlement);
        throw new X402Error(ExitCode.INVALID_402, `the refund was not accepted: ${reason}`);
      }

      const next = afterRefund(rec, refundAmount);
      if (next === undefined) deleteChannel(slot);
      else writeChannel({ ...rec, ...next, updatedAt: new Date(this.now()).toISOString() });
      record.payment.state = 'settled';
      record.payment.paid = false;
      record.payment.amount = '0';
      record.payment.channel = {
        id: channelId,
        kind: 'refund',
        request: '0',
        confirmed: true,
        ...(refundAmount !== undefined
          ? { deposit: formatUnits(refundAmount, option.decimals) }
          : {}),
      };
      record.exitCode = ExitCode.OK;
      this.commit(record);
      void level;
      return {
        ok: true,
        receiptId: id,
        url: prepared.url,
        channelId,
        ...(refundAmount !== undefined
          ? { refunded: formatUnits(refundAmount, option.decimals) }
          : {}),
        remaining:
          next === undefined
            ? '0'
            : formatUnits(BigInt(next.balance) - BigInt(next.charged), option.decimals),
        asset: option.assetSymbol,
        ...(settlement ? { settlement } : {}),
      };
    } catch (err) {
      return fail(err);
    } finally {
      release?.();
    }
  }

  /** The per-call cap in atomic units, when one is set. */
  private perCallCap(option: PaymentOption, opts: CallOptions): bigint | undefined {
    const raw = opts.max ?? this.config.limits.maxPerCall;
    if (raw === undefined || raw === '') return undefined;
    return parseUnits(String(raw), option.decimals);
  }

  private depositFlag(option: PaymentOption, opts: CallOptions): bigint | undefined {
    return opts.deposit === undefined || opts.deposit === ''
      ? undefined
      : parseUnits(opts.deposit, option.decimals);
  }

  /**
   * The plan the gates see, from the channel as last recorded and before the
   * signer is asked for an address. It is a first look: the real plan is made
   * again, under the lock, when the payer's address is known.
   */
  private planFromStore(option: PaymentOption, opts: CallOptions): ChannelPlan {
    const wallet = opts.wallet ?? this.deps.walletName ?? '';
    const backend = opts.signer ?? this.deps.backendName ?? '';
    const rec = readChannel(slotFor(option, wallet, backend, channelSalt(option)));
    return planChannelPayment({
      option,
      state: rec,
      depositFlag: this.depositFlag(option, opts),
      capAtomic: this.perCallCap(option, opts),
      multiplier: this.depositMultiplier(opts),
      maxDepositAtomic: this.maxDepositAtomic(option, opts),
    });
  }

  /** Scheme selection shared by probe and call. Refund forces its own scheme. */
  private selection(opts: CallOptions): SelectOptions {
    return {
      chains: opts.chains ?? [this.config.defaults.chain],
      preferChain: this.config.defaults.chain,
      scheme: opts.scheme,
      preferScheme: opts.scheme ? undefined : this.config.defaults.scheme,
      openChannels: this.openChannels(opts),
    };
  }

  /** Channels this wallet can spend a voucher from, with no new deposit. */
  private openChannels(opts: CallOptions): ChannelCoverage[] {
    const wallet = opts.wallet ?? this.deps.walletName ?? '';
    const backend = opts.signer ?? this.deps.backendName ?? '';
    const out: ChannelCoverage[] = [];
    for (const rec of listChannels()) {
      if (wallet !== '' && rec.wallet !== wallet) continue;
      if (backend !== '' && rec.backend !== backend) continue;
      const balance = BigInt(rec.balance);
      const charged = BigInt(rec.charged);
      const remaining = balance > charged ? balance - charged : 0n;
      if (remaining <= 0n) continue;
      out.push({
        chain: rec.chain,
        payTo: rec.config.receiver,
        asset: rec.asset,
        remainingAtomic: remaining,
      });
    }
    return out;
  }

  private depositMultiplier(opts: CallOptions): bigint {
    const raw = opts.depositMultiplier ?? this.config.channels?.depositMultiplier ?? 5;
    if (!Number.isInteger(raw) || raw < 3) {
      throw new X402Error(
        ExitCode.GENERIC,
        `deposit multiplier must be an integer >= 3, got ${String(raw)}`,
      );
    }
    return BigInt(raw);
  }

  private maxDepositAtomic(option: PaymentOption, opts: CallOptions): bigint | undefined {
    const raw = opts.maxDeposit ?? this.config.channels?.maxDeposit;
    if (raw === undefined || raw === '') return undefined;
    return parseUnits(String(raw), option.decimals);
  }

  /** After a 402 on a voucher: adopt the receiver's total if it is one this client can believe. */
  private repairChannel(
    option: PaymentOption,
    auth: AuthCacheEntry,
    second: HttpResponse,
  ): boolean {
    if (option.scheme !== BATCH_SETTLEMENT_SCHEME) return false;
    const sent = decodeSent(auth, option);
    if (!sent) return false;
    const raw = requirementsFromHeaders(second.headers) ?? parseJsonBody(second.body);
    return repairFromPaymentRequired(sent.slot, raw);
  }

  /** Say what is about to leave the wallet, and ask when a person is at the terminal. */
  private async confirmDeposit(
    deposit: bigint,
    option: PaymentOption,
    opts: CallOptions,
  ): Promise<void> {
    const amount = formatUnits(deposit, option.decimals);
    process.stderr.write(
      `depositing ${amount} ${option.assetSymbol} into escrow for ${option.payTo} on ${option.network} ` +
        `(this request is ${option.amount}; the rest stays refundable with \`rh-x402 channel refund\`).\n`,
    );
    if (opts.yes || !interactive()) return;
    const accepted = await confirm(`Deposit ${amount} ${option.assetSymbol} now?`, false);
    if (!accepted) {
      throw new X402Error(ExitCode.GENERIC, 'deposit declined. Nothing was signed.');
    }
  }

  /**
   * Build the payment with `@x402/evm` `BatchSettlementEvmScheme`, registered for
   * `eip155:*`. Returns undefined when that package is not installed, and the
   * caller signs with the vendored port instead. The deposit amount is the one
   * the gates and `--max-deposit` already accepted.
   */
  private async payWithBatchScheme(
    option: PaymentOption,
    signer: SignerBackend,
    from: string,
    context: PaymentPayloadContext,
    opts: CallOptions,
    slot: string,
    rec: ChannelRecord | undefined,
    plan: ChannelPlan,
    base: Omit<
      ChannelRecord,
      | 'balance'
      | 'charged'
      | 'signedMax'
      | 'updatedAt'
      | 'createdAt'
      | 'voucherSignature'
      | 'pendingDeposit'
    >,
    nowIso: string,
    validBefore: number,
  ): Promise<SignedPayment | undefined> {
    if (option.family !== 'evm') return undefined;
    const extra = isRecord(option.raw.extra) ? { ...option.raw.extra } : {};
    if (option.eip712) {
      if (extra.name === undefined) extra.name = option.eip712.name;
      if (extra.version === undefined) extra.version = option.eip712.version;
    }
    const cap = this.perCallCap(option, opts);
    const built = await createEvmBatchPayment({
      signer,
      payer: from,
      slot,
      x402Version: context.x402Version,
      requirements: {
        scheme: option.scheme,
        network: option.chain,
        amount: option.amountAtomic.toString(),
        asset: option.asset,
        payTo: option.payTo,
        maxTimeoutSeconds: option.maxTimeoutSeconds,
        extra,
      },
      depositMultiplier: Number(this.depositMultiplier(opts)),
      voucherOnly: plan.kind === 'voucher',
      ...(plan.kind === 'deposit' ? { depositAtomic: plan.deposit } : {}),
      ...(cap !== undefined ? { maxAmountPerPayment: cap.toString() } : {}),
    });
    if (!built) return undefined;

    const voucher = isRecord(built.payload.voucher) ? built.payload.voucher : undefined;
    const signedChannel = typeof voucher?.channelId === 'string' ? voucher.channelId : '';
    const maxRaw =
      typeof voucher?.maxClaimableAmount === 'string' ? voucher.maxClaimableAmount : '';
    const signature = typeof voucher?.signature === 'string' ? voucher.signature : '';
    if (signedChannel === '' || !/^\d+$/.test(maxRaw) || !signature.startsWith('0x')) {
      throw new X402Error(
        ExitCode.GENERIC,
        'the batch-settlement scheme returned a payload this CLI cannot send. Nothing was signed.',
      );
    }
    const maxClaimable = BigInt(maxRaw);
    const depositBody = isRecord(built.payload.deposit) ? built.payload.deposit : undefined;
    const depositRaw = typeof depositBody?.amount === 'string' ? depositBody.amount : undefined;
    const deposit =
      depositRaw !== undefined && /^\d+$/.test(depositRaw) ? BigInt(depositRaw) : undefined;
    const isDeposit = built.payload.type === 'deposit';
    if (plan.kind === 'voucher' && isDeposit) {
      throw new X402Error(
        ExitCode.GENERIC,
        'the batch-settlement scheme tried to deposit into a channel that can already cover this request. Nothing was signed.',
      );
    }
    if (plan.kind === 'deposit' && deposit !== plan.deposit) {
      throw new X402Error(
        ExitCode.GENERIC,
        `the batch-settlement scheme signed a deposit of ${deposit?.toString() ?? 'nothing'} atomic units, ` +
          `not the ${plan.deposit.toString()} the caps allowed. Nothing was signed.`,
      );
    }
    // The cache and the pending-deposit window follow the engine clock. The
    // scheme's own expiry is wall-clock, which a test (and a retry) cannot
    // share; in production the two clocks are the same.
    recordSigned(
      rec,
      { ...base, channelId: signedChannel },
      { maxClaimable, signature },
      isDeposit && deposit !== undefined ? { amount: deposit, until: validBefore } : undefined,
      nowIso,
    );
    return {
      nonce: signedChannel,
      validBefore,
      signature,
      payload: wrapPaymentPayload(option, built.payload, {
        ...context,
        ...(built.extensions ? { extensions: built.extensions } : {}),
      }),
    };
  }

  /**
   * Sign a `batch-settlement` payment: a voucher on the open channel, or a deposit
   * with a voucher when there is none or it would run out.
   *
   * What is signed is written to the channel record before it is returned, so a
   * crash between signing and sending cannot lose the highest voucher or forget
   * that a deposit is in flight.
   */
  private async signChannel(
    option: PaymentOption,
    signer: SignerBackend,
    from: string,
    context: PaymentPayloadContext,
    url: string,
    opts: CallOptions,
  ): Promise<SignedPayment> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const nowIso = new Date(this.now()).toISOString();
    const config = buildChannelConfig(option, from);
    const channelId = computeChannelId(config, option.chainId);
    const slot = slotFor(option, signer.wallet, signer.backend, config.salt);
    const chain = findChain(option.chain);
    const rpcUrl = chain ? rpcUrlFor(chain, this.config.rpc) : undefined;

    const rec = await prepareChannel({
      slot,
      config,
      channelId,
      option,
      wallet: signer.wallet,
      backend: signer.backend,
      url,
      nowSeconds,
      read: rpcUrl ? onChainReader(rpcUrl) : undefined,
    });
    const plan = planChannelPayment({
      option,
      state: rec,
      depositFlag: this.depositFlag(option, opts),
      capAtomic: this.perCallCap(option, opts),
      multiplier: this.depositMultiplier(opts),
      maxDepositAtomic: this.maxDepositAtomic(option, opts),
    });
    // The plan made under the lock is the one that counts. Gate it again: it can
    // move more than the first look did.
    this.gate(option, url, opts, plan);
    if (plan.kind === 'deposit') await this.confirmDeposit(plan.deposit, option, opts);

    const base = {
      version: 1 as const,
      slot,
      channelId,
      config,
      network: option.network,
      chain: option.chain,
      wallet: signer.wallet,
      backend: signer.backend,
      url,
      asset: option.asset,
      assetSymbol: option.assetSymbol,
      decimals: option.decimals,
    };
    const voucherDoc = voucherDocument(channelId, plan.maxClaimable, option.chainId);
    const validBefore = nowSeconds + Math.max(1, option.maxTimeoutSeconds);

    const viaSdk = await this.payWithBatchScheme(
      option,
      signer,
      from,
      context,
      opts,
      slot,
      rec,
      plan,
      base,
      nowIso,
      validBefore,
    );
    if (viaSdk) return viaSdk;

    if (plan.kind === 'voucher') {
      const signature = await signer.signTypedData(voucherDoc);
      recordSigned(rec, base, { maxClaimable: plan.maxClaimable, signature }, undefined, nowIso);
      const payload = voucherPayload(config, {
        channelId,
        maxClaimableAmount: plan.maxClaimable.toString(),
        signature,
      });
      return {
        nonce: channelId,
        validBefore,
        signature,
        typedData: voucherDoc,
        payload: wrapPaymentPayload(option, payload, context),
      };
    }

    let authorization: Record<string, unknown>;
    let until: number;
    let extensions = context.extensions;
    if (depositMethodOf(option) === 'eip3009') {
      const dep = eip3009DepositDocument({
        option,
        payer: from,
        config,
        channelId,
        amount: plan.deposit,
        now: nowSeconds,
      });
      const depositSignature = await signer.signTypedData(dep.document);
      until = dep.validBefore;
      authorization = {
        erc3009Authorization: {
          validAfter: '0',
          validBefore: String(dep.validBefore),
          salt: dep.salt,
          signature: depositSignature,
        },
      };
    } else {
      const dep = permit2DepositDocument({
        option,
        payer: from,
        config,
        channelId,
        amount: plan.deposit,
        now: nowSeconds,
      });
      const depositSignature = await signer.signTypedData(dep.document);
      until = Number(dep.deadline);
      authorization = {
        permit2Authorization: {
          from,
          permitted: { token: option.asset, amount: plan.deposit.toString() },
          spender: dep.document.message.spender,
          nonce: dep.nonce,
          deadline: dep.deadline,
          witness: { channelId },
          signature: depositSignature,
        },
      };
      extensions = await this.sponsoredPermit(
        option,
        signer,
        from,
        context,
        plan.deposit,
        dep.deadline,
      );
    }
    const signature = await signer.signTypedData(voucherDoc);
    recordSigned(
      rec,
      base,
      { maxClaimable: plan.maxClaimable, signature },
      { amount: plan.deposit, until },
      nowIso,
    );
    const payload = depositPayload(
      config,
      { channelId, maxClaimableAmount: plan.maxClaimable.toString(), signature },
      plan.deposit,
      authorization,
    );
    return {
      nonce: channelId,
      validBefore: until,
      signature,
      typedData: voucherDoc,
      payload: wrapPaymentPayload(option, payload, { ...context, extensions }),
    };
  }

  /** The EIP-2612 permit a Permit2 deposit needs when the wallet has not approved Permit2. */
  private async sponsoredPermit(
    option: PaymentOption,
    signer: SignerBackend,
    from: string,
    context: PaymentPayloadContext,
    amount: bigint,
    deadline: string,
  ): Promise<PaymentPayloadContext['extensions']> {
    const wants =
      isRecord(context.extensions) && context.extensions[EIP2612_GAS_SPONSORING_KEY] !== undefined;
    if (!wants) return context.extensions;
    const chain = findChain(option.chain);
    const rpcUrl = chain ? rpcUrlFor(chain, this.config.rpc) : undefined;
    if (!rpcUrl) throw new X402Error(ExitCode.INVALID_402, `no RPC endpoint for ${option.network}`);
    let covered = false;
    try {
      covered = (await readPermit2Allowance(rpcUrl, option.asset, from)) >= amount;
    } catch {
      // Unknown allowance: sign the permit.
    }
    if (covered) return context.extensions;
    const nonce = await readPermitNonce(rpcUrl, option.asset, from);
    const permit = buildEip2612Permit({
      option: { ...option, amountAtomic: amount },
      from,
      nonce,
      deadline,
    });
    const permitSignature = await signer.signTypedData(permit.typedData);
    return {
      ...context.extensions,
      [EIP2612_GAS_SPONSORING_KEY]: { info: { ...permit.info, signature: permitSignature } },
    };
  }

  /** Sign an `auth-capture` hold: up to the quoted amount moves into escrow until captured or voided. */
  private async signAuthCapture(
    option: PaymentOption,
    signer: SignerBackend,
    from: string,
    context: PaymentPayloadContext,
  ): Promise<SignedPayment> {
    const built = buildAuthCapture({ option, payer: from, now: Math.floor(this.now() / 1000) });
    const signature = await signer.signTypedData(built.document);
    return {
      nonce: built.nonce,
      validBefore: built.expiresAt,
      signature,
      typedData: built.document,
      payload: wrapPaymentPayload(option, built.payload(signature), context),
    };
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
      await this.assertCanSign(signer, option);
      const from = await signer.getAddress(option.chain);
      const key = authKey({
        url: prepared.url,
        method: prepared.method,
        body: prepared.body ?? '',
        payTo: option.payTo,
        amountAtomic: option.amountAtomic,
        asset: option.asset,
        chain: option.chain,
        family: option.family,
        wallet: signer.wallet,
        backend: signer.backend,
        // A v1 header cannot be replayed against a v2 provider (different
        // payload shape, different header), so the version is part of the
        // request identity rather than something a cache hit can paper over.
        x402Version: requirements.x402Version,
        scheme: option.scheme,
      });

      if (!opts.noCache) {
        const cached = readAuth(key, this.now());
        if (cached) return { ...cached, cacheHit: true };
      }

      await this.assertBalance(signer, option);

      const context = {
        x402Version: requirements.x402Version,
        resource: requirements.resource,
        extensions: requirements.extensions,
      };
      const signed =
        option.family === 'svm'
          ? await this.signSvm(option, signer, from, context)
          : option.scheme === 'upto'
            ? await this.signUpto(option, signer, from, context)
            : option.scheme === BATCH_SETTLEMENT_SCHEME
              ? await this.signChannel(option, signer, from, context, prepared.url, opts)
              : option.scheme === AUTH_CAPTURE_SCHEME
                ? await this.signAuthCapture(option, signer, from, context)
                : await this.signEvm(option, signer, from, context);
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
        nonce: signed.nonce,
        validBefore: signed.validBefore,
        signature: signed.signature,
        from,
        ...(signed.typedData ? { typedData: signed.typedData } : {}),
        x402Version: requirements.x402Version,
        headerName: paymentHeaderName(requirements.x402Version),
        header: encodePaymentHeader(signed.payload),
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

  /** Refuse before signing when the backend cannot sign what this chain needs. */
  private async assertCanSign(signer: SignerBackend, option: PaymentOption): Promise<void> {
    const caps = await signer.capabilities();
    const svm = option.family === 'svm';
    const able = svm ? caps.svm === true && signer.signSvmMessage !== undefined : caps.typedData;
    if (able) return;
    throw new X402Error(
      ExitCode.OWS_UNREACHABLE,
      `signer backend "${signer.backend}" cannot sign for ${option.network}: ` +
        `${svm ? 'a Solana transaction' : 'EIP-712 typed data'} is required. ` +
        'Nothing was signed.',
      { backend: signer.backend, network: option.network },
    );
  }

  private async signEvm(
    option: PaymentOption,
    signer: SignerBackend,
    from: string,
    context: PaymentPayloadContext,
  ): Promise<SignedPayment> {
    const built = buildAuthorization({ option, from, now: Math.floor(this.now() / 1000) });
    const signature = await signer.signTypedData(built.typedData);
    return {
      nonce: built.nonce,
      validBefore: built.validBefore,
      signature,
      typedData: built.typedData,
      payload: buildPaymentPayload(option, built.typedData, signature, context),
    };
  }

  /**
   * Sign an `upto` payment: a Permit2 witness transfer for the quoted ceiling.
   *
   * A wallet that has not yet approved Permit2 to move the token also signs an
   * EIP-2612 permit for the facilitator to submit first, when the quote declares
   * `eip2612GasSponsoring`. Deciding that needs two read-only RPC calls. If the
   * allowance read fails the permit is signed anyway, as the reference client
   * does: a redundant permit is harmless, a missing one is a failed payment. If
   * the permit's own nonce read fails, nothing is signed.
   */
  private async signUpto(
    option: PaymentOption,
    signer: SignerBackend,
    from: string,
    context: PaymentPayloadContext,
  ): Promise<SignedPayment> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const built = buildUptoPermit2({ option, from, now: nowSeconds });
    const signature = await signer.signTypedData(built.typedData);

    let extensions = context.extensions;
    const wantsPermit =
      isRecord(context.extensions) && context.extensions[EIP2612_GAS_SPONSORING_KEY] !== undefined;
    if (wantsPermit) {
      const chain = findChain(option.chain);
      const rpcUrl = chain ? rpcUrlFor(chain, this.config.rpc) : undefined;
      if (!rpcUrl) {
        throw new X402Error(ExitCode.INVALID_402, `no RPC endpoint for ${option.network}`);
      }
      let covered = false;
      try {
        covered = (await readPermit2Allowance(rpcUrl, option.asset, from)) >= option.amountAtomic;
      } catch {
        // Unknown allowance: fall through and sign the permit.
      }
      if (!covered) {
        const nonce = await readPermitNonce(rpcUrl, option.asset, from);
        const permit = buildEip2612Permit({
          option,
          from,
          nonce,
          deadline: built.authorization.deadline,
        });
        const permitSignature = await signer.signTypedData(permit.typedData);
        extensions = {
          ...context.extensions,
          [EIP2612_GAS_SPONSORING_KEY]: { info: { ...permit.info, signature: permitSignature } },
        };
      }
    }

    const payload: UptoSchemePayload = {
      signature,
      permit2Authorization: built.authorization,
    };
    return {
      nonce: built.authorization.nonce,
      validBefore: Number(built.authorization.deadline),
      signature,
      typedData: built.typedData,
      payload: wrapPaymentPayload(option, payload, { ...context, extensions }),
    };
  }

  /**
   * Build, sign and verify a Solana payment.
   *
   * The transaction is checked against the quote after signing and before it is
   * put in the payload, so nothing that fails verification can leave the
   * process or be cached.
   */
  private async signSvm(
    option: PaymentOption,
    signer: SignerBackend,
    from: string,
    context: PaymentPayloadContext,
  ): Promise<SignedPayment> {
    const chain = findChain(option.chain);
    const rpcUrl = chain ? rpcUrlFor(chain, this.config.rpc) : undefined;
    if (!rpcUrl) {
      throw new X402Error(ExitCode.INVALID_402, `no RPC endpoint for ${option.network}`);
    }
    const now = Math.floor(this.now() / 1000);
    const { blockhash } = await fetchLatestBlockhash(rpcUrl);
    const built = await buildSvmTransaction({ option, payer: from, blockhash, now });
    // SAFETY: `assertCanSign` has already checked this is present.
    const signature = await signer.signSvmMessage!(built.message);
    const transaction = await attachPayerSignature(built, from, signature);
    await verifySvmTransaction({ option, payer: from, transaction, blockhash });
    return {
      nonce: blockhash,
      validBefore: built.validBefore,
      signature: Buffer.from(signature).toString('base64'),
      payload: wrapPaymentPayload(option, { transaction }, context),
    };
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
    settledAtomicAmount?: bigint,
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
      ...(settledAtomicAmount !== undefined
        ? { settledAmount: formatUnits(settledAtomicAmount, option.decimals) }
        : {}),
      payTo: option.payTo,
      from: auth.from ?? (auth.typedData?.message.from as string | undefined) ?? '',
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
    data?: unknown;
    body?: string | undefined;
    headers?: Record<string, string>;
    capability?: string | undefined;
    provider?: string | undefined;
  }): LedgerRecord {
    const summary = summarizePayload(
      args.body ?? '',
      args.data,
      args.level,
      this.config.telemetry.redactKeys,
    );
    const headerSummary = args.headers ? summarizeHeaders(args.headers) : undefined;
    return {
      id: args.id,
      ts: new Date(this.now()).toISOString(),
      url: args.url,
      method: args.method,
      wallet: this.deps.walletName ?? null,
      ...(this.deps.backendName ? { backend: this.deps.backendName } : {}),
      ...(args.capability ? { capability: args.capability } : {}),
      ...(args.provider ? { provider: args.provider } : {}),
      request: {
        ...(summary.hash ? { dataHash: summary.hash } : {}),
        ...(summary.keys ? { dataKeys: summary.keys } : { dataKeys: topLevelKeys(args.data) }),
        ...(summary.body !== undefined ? { data: summary.body } : {}),
        ...(headerSummary ?? {}),
        bytes: summary.bytes,
      },
      payment: { paid: false, amount: '0', state: 'none' },
      response: { status: null, bytes: 0, latencyMs: 0 },
      exitCode: ExitCode.OK,
      agent: args.agent,
    };
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

  private errorResult(record: LedgerRecord, err: unknown): CallResult {
    return {
      ok: false,
      status: record.response.status,
      paid: record.payment.paid,
      paymentState: record.payment.state ?? 'none',
      amount: record.payment.amount,
      asset: record.payment.asset,
      receiptId: record.id,
      url: record.url,
      record,
      errorCode: exitCodeOf(err),
      error: messageOf(err),
      ...(err instanceof X402Error && err.detail ? { detail: err.detail } : {}),
    };
  }
}

/** What a cached or fresh authorization put on the wire for a channel, and the slot it belongs to. */
function decodeSent(
  auth: AuthCacheEntry,
  option: PaymentOption,
): { slot: string; sent: SentChannelPayload } | undefined {
  let body: Record<string, unknown>;
  try {
    // SAFETY: the header was produced by signChannel, whose payload is a plain object; a
    // payload that is not one fails the field checks below and returns undefined.
    body = decodePaymentHeader(auth.header).payload as unknown as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const voucher = body.voucher as { channelId?: unknown; maxClaimableAmount?: unknown } | undefined;
  const config = body.channelConfig as { salt?: unknown } | undefined;
  if (typeof voucher?.channelId !== 'string' || typeof voucher.maxClaimableAmount !== 'string')
    return undefined;
  if (typeof config?.salt !== 'string') return undefined;
  const isDeposit = body.type === 'deposit';
  const dep = isDeposit ? (body.deposit as { amount?: unknown } | undefined) : undefined;
  const deposit =
    typeof dep?.amount === 'string' && /^\d+$/.test(dep.amount) ? BigInt(dep.amount) : undefined;
  return {
    slot: slotFor(option, auth.wallet, auth.backend, config.salt),
    sent: {
      kind: isDeposit ? 'deposit' : 'voucher',
      channelId: voucher.channelId,
      maxClaimable: BigInt(voucher.maxClaimableAmount),
      deposit,
      request: option.amountAtomic,
      depositUntil: isDeposit ? auth.validBefore : undefined,
    },
  };
}

/** What a payment that left this process may have moved: a deposit for a channel, else the amount. */
function exposureOf(auth: AuthCacheEntry, option: PaymentOption): bigint {
  if (option.scheme !== BATCH_SETTLEMENT_SCHEME) return option.amountAtomic;
  return decodeSent(auth, option)?.sent.deposit ?? 0n;
}

export interface RefundResult {
  ok: boolean;
  receiptId: string;
  url: string;
  channelId?: string;
  /** Human decimal. Absent when the refund was for everything left. */
  refunded?: string;
  /** What is left refundable in the channel afterwards. */
  remaining?: string;
  asset?: string;
  settlement?: SettlementResponse;
  errorCode?: number;
  error?: string;
}

/** What a dry run should say a channel call would do, since the quote alone understates it. */
function channelWarnings(plan: ChannelPlan | undefined, option: PaymentOption): string[] {
  if (!plan) return [];
  if (plan.kind === 'deposit') {
    return [
      `this call would open or top up a payment channel: ${formatUnits(plan.deposit, option.decimals)} ${option.assetSymbol} moves into escrow now, ` +
        `${option.amount} of it for this request, and the rest stays refundable (rh-x402 channel refund).`,
    ];
  }
  return [
    `this call would pay a voucher from the open channel: ${option.amount} ${option.assetSymbol} at most, no new money leaves the wallet.`,
  ];
}
