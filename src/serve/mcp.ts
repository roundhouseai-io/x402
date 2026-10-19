import { createInterface } from 'node:readline';
import { messageOf, exitCodeOf, ExitCodeName, X402Error, ExitCode } from '../core/errors.js';
import { jsonSafe, toEnvelope } from '../core/output.js';
import { discoverMarket, filterByAllowlist } from '../core/discover.js';
import {
  readRecords,
  queryRecords,
  sumRecords,
  GROUP_KEYS,
  isGroupKey,
  type GroupKey,
} from '../core/ledger.js';
import type { HeaderMap } from '../core/http.js';
import {
  isJsonObject,
  isNumber,
  isString,
  numberField,
  parseJson,
  stringField,
  type JsonObject,
  type JsonValue,
} from '../core/json.js';
import type { Engine } from '../core/engine.js';
import type { X402Config } from '../core/config.js';

/**
 * Minimal MCP server over stdio (JSON-RPC 2.0). Exposes the same engine as the
 * HTTP surface so any MCP client can reach every x402 provider with no
 * per-provider integration.
 */
export const PROTOCOL_VERSION = '2024-11-05';

export interface McpDeps {
  engine: Engine;
  config: X402Config;
  version: string;
}

export interface JsonRpcRequest {
  /** Always `2.0` from a conforming client; not checked, as before. */
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: JsonObject;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: object;
  error?: { code: number; message: string };
}

/** A parsed line shaped like a JSON-RPC request: a string method, optional object params. */
export function isJsonRpcRequest<T>(value: T): value is T & JsonRpcRequest {
  if (!isJsonObject(value) || !isString(value.method)) return false;
  const { id, params } = value;
  const idOk = id === undefined || id === null || isString(id) || isNumber(id);
  return idOk && (params === undefined || isJsonObject(params));
}

export const TOOLS = [
  {
    name: 'x402_call',
    description:
      'Make an HTTP request, pay the x402 price if one is quoted, and return the response. Spend limits apply.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute URL, or x402:<capability> to resolve via the index',
        },
        method: { type: 'string' },
        data: { type: 'object', description: 'Query params for GET, JSON body otherwise' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        max: {
          type: 'string',
          description: 'Refuse if the quoted price exceeds this, e.g. "0.01"',
        },
        dryRun: { type: 'boolean', description: 'Report the price without paying' },
      },
      required: ['url'],
    },
  },
  {
    name: 'x402_probe',
    description: 'Fetch x402 payment requirements for a URL or capability. Never pays.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, data: { type: 'object' } },
      required: ['url'],
    },
  },
  {
    name: 'x402_discover',
    description:
      'List providers of a capability from the Roundhouse index, cheapest first, with the ' +
      'capability-wide min/median/spot/max price and spread to judge an offer against.',
    inputSchema: {
      type: 'object',
      properties: { capability: { type: 'string' } },
      required: ['capability'],
    },
  },
  {
    name: 'x402_history',
    description: 'Query the local payment ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'e.g. 24h, 7d, or an ISO timestamp' },
        paidOnly: { type: 'boolean' },
        sum: { type: 'boolean' },
        by: {
          type: 'string',
          enum: ['payTo', 'url', 'wallet', 'asset', 'agent', 'day', 'capability'],
        },
      },
    },
  },
] as const;

export async function runMcpStdio(deps: McpDeps): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let parsed: JsonValue;
    try {
      parsed = parseJson(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    if (!isJsonRpcRequest(parsed)) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
      continue;
    }
    const response = await dispatch(deps, parsed);
    if (response) write(response);
  }
}

function write(payload: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(payload, jsonSafe)}\n`);
}

export async function dispatch(
  deps: McpDeps,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | undefined> {
  // Notifications carry no id and expect no response.
  const isNotification = req.id === undefined || req.id === null;
  const reply = <T extends object>(result: T): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id: req.id ?? null,
    result,
  });

  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'x402', version: deps.version },
      });
    case 'notifications/initialized':
      return undefined;
    case 'ping':
      return isNotification ? undefined : reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(req.params?.name ?? '');
      const rawArgs = req.params?.arguments;
      const args = isJsonObject(rawArgs) ? rawArgs : {};
      try {
        const result = await callTool(deps, name, args);
        return reply({
          content: [{ type: 'text', text: result.text }],
          isError: !result.ok,
        });
      } catch (err) {
        const code = exitCodeOf(err);
        return reply({
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: false,
                  error: messageOf(err),
                  errorCode: code,
                  errorName: ExitCodeName[code],
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return undefined;
      return {
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: { code: -32601, message: `method not found: ${req.method}` },
      };
  }
}

/** A tool's answer: whether it succeeded, and the JSON text the client reads. */
interface ToolOutput {
  ok: boolean;
  text: string;
}

function toolOutput<T extends { ok: boolean }>(payload: T): ToolOutput {
  return { ok: payload.ok, text: JSON.stringify(payload, jsonSafe, 2) };
}

/** A tool's `headers` argument, every value stringified. */
function headersArg(value: JsonValue | undefined): HeaderMap | undefined {
  if (!isJsonObject(value)) return undefined;
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(value)) out[k] = String(v);
  return out;
}

async function callTool(deps: McpDeps, name: string, args: JsonObject): Promise<ToolOutput> {
  switch (name) {
    case 'x402_call': {
      const result = await deps.engine.call({
        target: String(args.url ?? ''),
        method: stringField(args, 'method'),
        data: args.data,
        headers: headersArg(args.headers),
        max: args.max === undefined ? undefined : String(args.max),
        dryRun: args.dryRun === true,
        agentToken: 'mcp',
      });
      return toolOutput(toEnvelope(result));
    }
    case 'x402_probe': {
      const probe = await deps.engine.probe({ target: String(args.url ?? ''), data: args.data });
      return toolOutput({
        ok: true,
        url: probe.url,
        status: probe.status,
        paymentRequired: probe.status === 402,
        selected: probe.selected && {
          amount: probe.selected.amount,
          asset: probe.selected.assetSymbol,
          network: probe.selected.network,
          payTo: probe.selected.payTo,
          scheme: probe.selected.scheme,
        },
      });
    }
    case 'x402_discover': {
      const capability = String(args.capability ?? '');
      const market = await discoverMarket(capability, deps.config);
      const providers = filterByAllowlist(market.providers, deps.config);
      return toolOutput({
        ok: true,
        capability,
        name: market.name ?? null,
        unit: market.unit ?? null,
        count: providers.length,
        stats: market.stats ?? null,
        // The index capped the offer list: the cheapest here is not
        // necessarily the cheapest that exists, and `stats` describes more.
        truncated: market.truncated ?? false,
        indexSurface: market.from,
        providers,
      });
    }
    case 'x402_history': {
      const byRaw = stringField(args, 'by');
      let by: GroupKey | undefined;
      if (byRaw) {
        if (!isGroupKey(byRaw)) {
          throw new X402Error(ExitCode.GENERIC, `by must be one of ${GROUP_KEYS.join('|')}`);
        }
        by = byRaw;
      }
      const records = queryRecords(readRecords(), {
        since: stringField(args, 'since'),
        paidOnly: args.paidOnly === true,
        limit: numberField(args, 'limit'),
      });
      if (args.sum === true || by) {
        return toolOutput({ ok: true, groupedBy: by ?? null, rows: sumRecords(records, by) });
      }
      return toolOutput({ ok: true, count: records.length, records });
    }
    default:
      return toolOutput({ ok: false, error: `unknown tool: ${name}` });
  }
}
