import { createInterface } from 'node:readline';
import { messageOf, exitCodeOf, ExitCodeName } from '../core/errors.js';
import { toEnvelope } from '../core/output.js';
import { discoverMarket, filterByAllowlist } from '../core/discover.js';
import { readRecords, queryRecords, sumRecords, type GroupKey } from '../core/ledger.js';
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

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
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
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    const response = await dispatch(deps, req);
    if (response) write(response);
  }
}

function write(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export async function dispatch(
  deps: McpDeps,
  req: JsonRpcRequest,
): Promise<Record<string, unknown> | undefined> {
  // Notifications carry no id and expect no response.
  const isNotification = req.id === undefined || req.id === null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0' as const, id: req.id ?? null, result });

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
      const args = (req.params?.arguments ?? {}) as Record<string, any>;
      try {
        const result = await callTool(deps, name, args);
        return reply({
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: result.ok === false,
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

async function callTool(
  deps: McpDeps,
  name: string,
  args: Record<string, any>,
): Promise<Record<string, any>> {
  switch (name) {
    case 'x402_call': {
      const result = await deps.engine.call({
        target: String(args.url ?? ''),
        method: args.method,
        data: args.data,
        headers: args.headers,
        max: args.max,
        dryRun: args.dryRun === true,
        agentToken: 'mcp',
      });
      return toEnvelope(result) as unknown as Record<string, any>;
    }
    case 'x402_probe': {
      const probe = await deps.engine.probe({ target: String(args.url ?? ''), data: args.data });
      return {
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
      };
    }
    case 'x402_discover': {
      const capability = String(args.capability ?? '');
      const market = await discoverMarket(capability, deps.config);
      const providers = filterByAllowlist(market.providers, deps.config);
      return {
        ok: true,
        capability,
        name: market.name ?? null,
        unit: market.unit ?? null,
        count: providers.length,
        stats: market.stats ?? null,
        indexSurface: market.from,
        providers,
      };
    }
    case 'x402_history': {
      const records = queryRecords(readRecords(), {
        since: args.since,
        paidOnly: args.paidOnly === true,
        limit: args.limit,
      });
      if (args.sum === true || args.by) {
        return {
          ok: true,
          groupedBy: args.by ?? null,
          rows: sumRecords(records, args.by as GroupKey),
        };
      }
      return { ok: true, count: records.length, records };
    }
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}
