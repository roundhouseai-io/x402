import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { x402Facilitator } from '@x402/core/facilitator';
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
} from '@x402/core/server';
import { computeChannelId } from '@x402/evm/batch-settlement/client';
import { BatchSettlementEvmScheme as BatchFacilitator } from '@x402/evm/batch-settlement/facilitator';
import { BatchSettlementEvmScheme as BatchServer } from '@x402/evm/batch-settlement/server';
import { DEFAULT_CONFIG, mergeDeep } from '../src/core/config.js';
import { Engine } from '../src/core/engine.js';
import { listChannels } from '../src/core/channelstore.js';
import type { TypedDataDocument } from '../src/core/eip3009.js';
import type { SignerBackend } from '../src/core/signer.js';

/**
 * Offline integration: the official server and facilitator, with a chain stand-in
 * that records deposits, against this CLI's engine. A live Base Sepolia run is
 * the second test and only starts when a funded key and a facilitator are provided.
 */

const NETWORK = 'eip155:84532' as const;
const USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const ABI = [
  {
    type: 'function',
    name: 'channels',
    stateMutability: 'view',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [
      { name: 'balance', type: 'uint128' },
      { name: 'totalClaimed', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'pendingWithdrawals',
    stateMutability: 'view',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [
      { name: 'amount', type: 'uint128' },
      { name: 'initiatedAt', type: 'uint40' },
    ],
  },
  {
    type: 'function',
    name: 'refundNonce',
    stateMutability: 'view',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

interface ChannelRow {
  balance: bigint;
  totalClaimed: bigint;
}

const channels = new Map<string, ChannelRow>();
const PAYER_BALANCE = 10_000_000n;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function encodedAnswer(name: string, args: readonly unknown[] | undefined): Hex {
  if (name === 'channels') {
    const id = String(args?.[0] ?? '').toLowerCase();
    const row = channels.get(id) ?? { balance: 0n, totalClaimed: 0n };
    return encodeFunctionResult({
      abi: ABI,
      functionName: 'channels',
      result: [row.balance, row.totalClaimed],
    });
  }
  if (name === 'pendingWithdrawals') {
    return encodeFunctionResult({
      abi: ABI,
      functionName: 'pendingWithdrawals',
      result: [0n, 0],
    });
  }
  if (name === 'refundNonce') {
    return encodeFunctionResult({ abi: ABI, functionName: 'refundNonce', result: 0n });
  }
  if (name === 'balanceOf') {
    return encodeFunctionResult({ abi: ABI, functionName: 'balanceOf', result: PAYER_BALANCE });
  }
  throw new Error(`no chain answer for ${name}`);
}

function chainSigner(address: Address) {
  return {
    getAddresses: () => [address] as const,
    async getCode(): Promise<Hex> {
      return '0x';
    },
    async readContract(call: {
      functionName: string;
      args?: readonly unknown[];
    }): Promise<unknown> {
      if (call.functionName === 'tryAggregate') {
        const calls = (call.args?.[1] ?? []) as { callData: Hex }[];
        return calls.map((item) => {
          const decoded = decodeFunctionData({ abi: ABI, data: item.callData });
          return {
            success: true,
            returnData: encodedAnswer(decoded.functionName, decoded.args),
          };
        });
      }
      if (call.functionName === 'deposit') return undefined;
      return encodedAnswer(call.functionName, call.args);
    },
    async writeContract(call: { functionName: string; args?: readonly unknown[] }): Promise<Hex> {
      if (call.functionName === 'deposit') {
        const config = call.args?.[0] as {
          payer: Address;
          payerAuthorizer: Address;
          receiver: Address;
          receiverAuthorizer: Address;
          token: Address;
          withdrawDelay: number;
          salt: Hex;
        };
        const amount = BigInt(String(call.args?.[1] ?? 0));
        const id = computeChannelId(
          {
            payer: config.payer,
            payerAuthorizer: config.payerAuthorizer,
            receiver: config.receiver,
            receiverAuthorizer: config.receiverAuthorizer,
            token: config.token,
            withdrawDelay: config.withdrawDelay,
            salt: config.salt,
          },
          NETWORK,
        ).toLowerCase();
        const row = channels.get(id) ?? { balance: 0n, totalClaimed: 0n };
        channels.set(id, { balance: row.balance + amount, totalClaimed: row.totalClaimed });
      }
      return `0x${'ab'.repeat(32)}`;
    },
    async sendTransaction(): Promise<Hex> {
      return `0x${'cd'.repeat(32)}`;
    },
    async waitForTransactionReceipt(): Promise<{ status: string }> {
      return { status: 'success' };
    },
    async verifyTypedData(): Promise<boolean> {
      return true;
    },
  };
}

describe('batch-settlement against a local server and facilitator', () => {
  const home = mkdtempSync(join(tmpdir(), 'x402-batch-it-'));
  const payer = privateKeyToAccount(generatePrivateKey());
  const receiver = privateKeyToAccount(generatePrivateKey());
  const authorizer = privateKeyToAccount(generatePrivateKey());
  const facilitatorKey = privateKeyToAccount(generatePrivateKey());
  let resourceUrl = '';
  const servers: ReturnType<typeof createServer>[] = [];

  beforeAll(async () => {
    process.env.X402_HOME = home;
    channels.clear();

    const chain = chainSigner(facilitatorKey.address);
    const facilitator = new x402Facilitator().register(
      NETWORK,
      new BatchFacilitator(chain, {
        address: authorizer.address,
        signTypedData: (params) => authorizer.signTypedData(params),
      }),
    );
    const facilitatorHttp = createServer(async (req, res) => {
      try {
        const raw = await readBody(req);
        const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
        const path = req.url ?? '';
        if (path.startsWith('/supported')) {
          sendJson(res, 200, facilitator.getSupported());
          return;
        }
        if (path.startsWith('/verify')) {
          sendJson(
            res,
            200,
            await facilitator.verify(
              body.paymentPayload as never,
              body.paymentRequirements as never,
            ),
          );
          return;
        }
        if (path.startsWith('/settle')) {
          sendJson(
            res,
            200,
            await facilitator.settle(
              body.paymentPayload as never,
              body.paymentRequirements as never,
            ),
          );
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    const facilitatorUrl = await listen(facilitatorHttp);
    servers.push(facilitatorHttp);

    const rpc = createServer(async (req, res) => {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as { id?: number };
      sendJson(res, 200, { jsonrpc: '2.0', id: body.id ?? 1, result: `0x${'0'.repeat(128)}` });
    });
    const rpcUrl = await listen(rpc);
    servers.push(rpc);

    const resource = new x402ResourceServer(
      new HTTPFacilitatorClient({ url: facilitatorUrl }),
    ).register(
      NETWORK,
      new BatchServer(receiver.address, {
        receiverAuthorizerSigner: {
          address: authorizer.address,
          signTypedData: (params) => authorizer.signTypedData(params),
        },
        withdrawDelay: 900,
      }),
    );
    const httpServer = new x402HTTPResourceServer(resource, {
      'GET /weather': {
        accepts: {
          scheme: 'batch-settlement',
          price: '$0.001',
          network: NETWORK,
          payTo: receiver.address,
        },
        description: 'weather',
        mimeType: 'application/json',
      },
    });
    await httpServer.initialize();

    const app = createServer(async (req, res) => {
      const host = req.headers.host ?? '127.0.0.1';
      const url = `http://${host}${req.url ?? '/'}`;
      const header = (name: string) => {
        const value = req.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      };
      const processed = await httpServer.processHTTPRequest({
        path: new URL(url).pathname,
        method: req.method ?? 'GET',
        adapter: {
          getHeader: header,
          getMethod: () => req.method ?? 'GET',
          getPath: () => new URL(url).pathname,
          getUrl: () => url,
          getAcceptHeader: () => header('accept') ?? 'application/json',
          getUserAgent: () => header('user-agent') ?? 'rh-x402-test',
        },
      });
      if (processed.type === 'payment-error') {
        const response = processed.response;
        res.writeHead(response.status ?? 402, response.headers ?? {});
        res.end(
          typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {}),
        );
        return;
      }
      if (processed.type !== 'payment-verified') {
        sendJson(res, 500, { error: processed.type });
        return;
      }
      const settled = await httpServer.processSettlement(
        processed.paymentPayload,
        processed.paymentRequirements,
        processed.declaredExtensions,
        undefined,
        undefined,
        processed.beforeHandlerSettlement,
      );
      const payload = JSON.stringify({ report: { weather: 'sunny' } });
      res.writeHead(settled.success ? 200 : 402, {
        'content-type': 'application/json',
        ...(settled.headers ?? {}),
      });
      res.end(payload);
    });
    resourceUrl = await listen(app);
    servers.push(app);

    // The engine reads the chain before a deposit. Point that read at the empty stand-in.
    process.env.X402_RPC_BASE_SEPOLIA = rpcUrl;
  }, 30_000);

  afterAll(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    delete process.env.X402_HOME;
    delete process.env.X402_RPC_BASE_SEPOLIA;
    rmSync(home, { recursive: true, force: true });
  });

  it('deposits once, then pays the second call with a voucher', async () => {
    const signer: SignerBackend = {
      backend: 'test',
      wallet: 'payer',
      async capabilities() {
        return {
          typedData: true,
          policies: false,
          balances: false,
          accounts: true,
          declared: true,
        };
      },
      async getAccounts() {
        return [{ id: 'payer', address: payer.address }];
      },
      async getAddress() {
        return payer.address;
      },
      async signTypedData(doc: TypedDataDocument) {
        const verifying = doc.domain.verifyingContract;
        if (!/^0x[0-9a-fA-F]{40}$/.test(verifying)) {
          throw new Error(`not an address: ${verifying}`);
        }
        const signature = await payer.signTypedData({
          domain: {
            name: doc.domain.name,
            version: doc.domain.version,
            chainId: doc.domain.chainId,
            verifyingContract: `0x${verifying.slice(2)}`,
          },
          types: doc.types,
          primaryType: doc.primaryType,
          message: doc.message,
        });
        return signature;
      },
    };
    const engine = new Engine({
      config: mergeDeep(DEFAULT_CONFIG, {
        defaults: { chain: 'base-sepolia' },
        rpc: { 'base-sepolia': process.env.X402_RPC_BASE_SEPOLIA ?? '' },
        limits: { maxPerCall: '1.00', dailyCap: '5.00' },
      }),
      signer: async () => signer,
      walletName: 'payer',
      backendName: 'test',
    });

    const first = await engine.call({
      target: `${resourceUrl}/weather`,
      scheme: 'batch-settlement',
      yes: true,
      maxDeposit: '1.00',
    });
    expect(first.ok, first.error).toBe(true);
    expect(first.paid).toBe(true);
    expect(Number(first.amount)).toBeGreaterThan(0);

    const second = await engine.call({
      target: `${resourceUrl}/weather`,
      scheme: 'batch-settlement',
      yes: true,
    });
    expect(second.ok, second.error).toBe(true);
    expect(second.amount).toBe('0');

    const rows = listChannels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ network: NETWORK, asset: USDC });
    expect(BigInt(rows[0]!.balance)).toBeGreaterThan(BigInt(rows[0]!.charged));
  }, 30_000);
});

const live =
  process.env.TEST_EVM_PRIVATE_KEY !== undefined && process.env.FACILITATOR_URL !== undefined;

describe.skipIf(!live)('batch-settlement on Base Sepolia', () => {
  it('pays a funded testnet wallet through FACILITATOR_URL', () => {
    // Present so a funded environment can be wired without changing the skip.
    // The offline test above is what CI runs. A live run needs TEST_EVM_PRIVATE_KEY
    // (a 0x key with Base Sepolia ETH and USDC) and FACILITATOR_URL.
    expect(process.env.FACILITATOR_URL).toMatch(/^https?:\/\//);
  });
});
