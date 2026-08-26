import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { X402Error, ExitCode, ExitCodeName, exitCodeOf, messageOf } from '../core/errors.js';
import { toEnvelope, type Envelope } from '../core/output.js';
import { capabilityOf, discover, filterByAllowlist } from '../core/discover.js';
import {
  readRecords,
  queryRecords,
  sumRecords,
  spentToday,
  GROUP_KEYS,
  type GroupKey,
} from '../core/ledger.js';
import { parseUnits, formatUnits } from '../core/assets.js';
import { outboxDepth } from '../core/telemetry.js';
import type { Engine, CallResult } from '../core/engine.js';
import type { X402Config } from '../core/config.js';
import type { OwsClient } from '../core/ows.js';
import { verifyToken, tokenAllowsCapability, type CallerToken } from './tokens.js';

export interface ServeDeps {
  engine: Engine;
  config: X402Config;
  ows: OwsClient;
  host: string;
  port: number;
  /** Loosens auth for `--no-auth` local development only. */
  requireAuth?: boolean;
}

interface IdempotentEntry {
  expiresAt: number;
  envelope: Envelope;
  bodyReplay: boolean;
}

/**
 * The unified endpoint: a spend-authorized local proxy over the same engine the
 * CLI uses. Anything that can reach it can spend from the wallet.
 */
export function createServeServer(deps: ServeDeps): Server {
  const idempotency = new Map<string, IdempotentEntry>();

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      sendJson(res, 500, { ok: false, error: messageOf(err), errorCode: ExitCode.GENERIC });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${deps.host}:${deps.port}`);
    const route = `${req.method} ${url.pathname}`;

    let token: CallerToken | undefined;
    if (deps.requireAuth !== false) {
      const header = req.headers.authorization ?? '';
      const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
      token = bearer ? verifyToken(bearer.trim()) : undefined;
      if (!token) {
        sendJson(res, 401, {
          ok: false,
          error: 'missing or invalid caller token; mint one with `x402 serve token create <name>`',
          errorCode: ExitCode.OWS_UNREACHABLE,
          errorName: ExitCodeName[ExitCode.OWS_UNREACHABLE],
        });
        return;
      }
    }

    try {
      switch (route) {
        case 'POST /v1/call':
          await handleCall(req, res, url, token);
          return;
        case 'POST /v1/probe':
          await handleProbe(req, res);
          return;
        case 'GET /v1/discover':
          await handleDiscover(res, url);
          return;
        case 'GET /v1/history':
          handleHistory(res, url, token);
          return;
        case 'GET /v1/health':
          await handleHealth(res);
          return;
        default:
          sendJson(res, 404, { ok: false, error: `no route ${route}` });
      }
    } catch (err) {
      const code = exitCodeOf(err);
      sendJson(res, statusForCode(code), {
        ok: false,
        error: messageOf(err),
        errorCode: code,
        errorName: ExitCodeName[code],
      });
    }
  }

  async function handleCall(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    token: CallerToken | undefined,
  ): Promise<void> {
    const body = await readJsonBody(req);
    const target = String(body.url ?? '');
    if (target === '') throw new X402Error(ExitCode.GENERIC, 'url is required');

    const capability = capabilityOf(target);
    if (token && !tokenAllowsCapability(token, capability)) {
      throw new X402Error(
        ExitCode.ALLOWLIST_DENIED,
        `token "${token.name}" is limited to capabilities: ${(token.capabilities ?? []).join(', ')}`,
      );
    }

    const idempotencyKey = header(req, 'idempotency-key');
    if (idempotencyKey) {
      const hit = idempotency.get(idempotencyKey);
      if (hit && hit.expiresAt > Date.now()) {
        sendJson(res, 200, { ...hit.envelope, replayed: true, bodyReplay: hit.bodyReplay });
        return;
      }
    }

    // Token limits sit on top of the global caps and the OWS policy layer.
    const max = tightestMax(
      body.max === undefined ? undefined : String(body.max),
      token?.maxPerCall,
    );
    if (token?.budgetDaily) enforceTokenBudget(token);

    const result: CallResult = await deps.engine.call({
      target,
      method: body.method === undefined ? undefined : String(body.method),
      data: body.data,
      headers: normalizeHeaders(body.headers),
      timeoutSeconds: body.timeout === undefined ? undefined : Number(body.timeout),
      max,
      chains: Array.isArray(body.chain)
        ? body.chain.map(String)
        : body.chain === undefined
          ? undefined
          : [String(body.chain)],
      dryRun: body.dryRun === true,
      noCache: body.noCache === true,
      form: body.form === true,
      bodyAlways: body.bodyAlways === true,
      agentToken: token?.name,
    });

    const envelope = toEnvelope(result);
    if (idempotencyKey && result.receipt) {
      const replayable = deps.config.telemetry.payload === 'full';
      idempotency.set(idempotencyKey, {
        expiresAt: result.receipt.validBefore * 1000,
        envelope: replayable ? envelope : { ...envelope, body: undefined },
        bodyReplay: replayable,
      });
    }
    sendJson(res, result.ok ? 200 : statusForCode(result.errorCode ?? ExitCode.GENERIC), envelope);
  }

  async function handleProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const target = String(body.url ?? '');
    if (target === '') throw new X402Error(ExitCode.GENERIC, 'url is required');
    const probe = await deps.engine.probe({
      target,
      data: body.data,
      method: body.method === undefined ? undefined : String(body.method),
      headers: normalizeHeaders(body.headers),
    });
    sendJson(res, 200, {
      ok: true,
      url: probe.url,
      status: probe.status,
      paymentRequired: probe.status === 402,
      capability: probe.capability,
      provider: probe.provider?.url,
      selected: probe.selected
        ? {
            scheme: probe.selected.scheme,
            network: probe.selected.network,
            chain: probe.selected.chain,
            asset: probe.selected.assetSymbol,
            amount: probe.selected.amount,
            payTo: probe.selected.payTo,
          }
        : undefined,
      options: probe.requirements?.options.map((o) => ({
        scheme: o.scheme,
        network: o.network,
        asset: o.assetSymbol,
        amount: o.amount,
        payTo: o.payTo,
      })),
    });
  }

  async function handleDiscover(res: ServerResponse, url: URL): Promise<void> {
    const capability = url.searchParams.get('capability');
    if (!capability)
      throw new X402Error(ExitCode.GENERIC, 'capability query parameter is required');
    const all = await discover(capability, deps.config);
    const providers = filterByAllowlist(all, deps.config);
    sendJson(res, 200, {
      ok: true,
      capability,
      pinned: deps.config.pins[capability] ?? null,
      count: providers.length,
      providers,
    });
  }

  function handleHistory(res: ServerResponse, url: URL, token: CallerToken | undefined): void {
    const byRaw = url.searchParams.get('by');
    if (byRaw && !GROUP_KEYS.includes(byRaw as GroupKey)) {
      throw new X402Error(ExitCode.GENERIC, `by must be one of ${GROUP_KEYS.join('|')}`);
    }
    const records = queryRecords(readRecords(), {
      since: url.searchParams.get('since') ?? undefined,
      until: url.searchParams.get('until') ?? undefined,
      paidOnly: url.searchParams.get('paidOnly') === 'true',
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      // A non-admin token sees only its own records.
      token: token && !token.admin ? token.name : undefined,
    });
    if (url.searchParams.get('sum') === 'true' || byRaw) {
      sendJson(res, 200, {
        ok: true,
        groupedBy: byRaw ?? null,
        rows: sumRecords(records, (byRaw as GroupKey) ?? undefined),
      });
      return;
    }
    sendJson(res, 200, { ok: true, count: records.length, records });
  }

  async function handleHealth(res: ServerResponse): Promise<void> {
    const ows = await deps.ows.health();
    sendJson(res, ows.ok ? 200 : 503, {
      ok: ows.ok,
      ows,
      wallet: deps.config.wallet.default ?? null,
      outboxDepth: outboxDepth(),
      payloadLevel: deps.config.telemetry.payload,
      limits: deps.config.limits,
    });
  }

  function enforceTokenBudget(token: CallerToken): void {
    const decimals = 6;
    const cap = parseUnits(token.budgetDaily!, decimals);
    const mine = readRecords().filter((r) => r.agent?.token === token.name);
    const spent = spentToday(mine, '', decimals);
    if (spent >= cap) {
      throw new X402Error(
        ExitCode.BUDGET_EXHAUSTED,
        `token "${token.name}" has spent ${formatUnits(spent, decimals)} of its ${token.budgetDaily} daily budget`,
      );
    }
  }

  return server;
}

/** The stricter of a request-level and a token-level per-call cap. */
export function tightestMax(requested?: string, tokenMax?: string): string | undefined {
  if (!requested) return tokenMax;
  if (!tokenMax) return requested;
  try {
    return parseUnits(requested, 6) <= parseUnits(tokenMax, 6) ? requested : tokenMax;
  } catch {
    return tokenMax;
  }
}

/** HTTP status for a CLI exit code. The exit code itself travels in errorCode. */
export function statusForCode(code: number): number {
  switch (code) {
    case ExitCode.OK:
      return 200;
    case ExitCode.INVALID_402:
      return 502;
    case ExitCode.POLICY_DENIED:
    case ExitCode.ALLOWLIST_DENIED:
      return 403;
    case ExitCode.OVER_MAX:
    case ExitCode.BUDGET_EXHAUSTED:
      return 429;
    case ExitCode.INSUFFICIENT_BALANCE:
      return 402;
    case ExitCode.OWS_UNREACHABLE:
      return 503;
    case ExitCode.PAID_NO_RESPONSE:
      return 502;
    default:
      return 500;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeHeaders(input: unknown): Record<string, string> | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = String(v);
  return out;
}

async function readJsonBody(
  req: IncomingMessage,
  limitBytes = 1_000_000,
): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new X402Error(ExitCode.GENERIC, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null)
      throw new Error('body must be a JSON object');
    return parsed as Record<string, any>;
  } catch (err) {
    throw new X402Error(ExitCode.GENERIC, `invalid JSON body: ${(err as Error).message}`);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
