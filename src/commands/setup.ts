import { ExitCode, X402Error } from '../core/errors.js';
import { writeCompactJson, writeErr } from '../core/output.js';
import { bool, str, type ParsedArgs } from '../core/args.js';
import { parseUnits } from '../core/assets.js';
import { parseDuration } from '../core/duration.js';
import { waitForBalance } from '../core/fundwait.js';
import { readBalances } from '../core/rpc.js';
import { request, parseJsonBody } from '../core/http.js';
import { loadConfig, readRawConfig } from '../core/config.js';
import { ask, confirm, interactive, select } from '../core/prompt.js';
import { globalRootWritable, runSetup, writeConfig } from '../core/setup.js';
import { grantPolicyKey } from '../core/owspolicy.js';
import {
  collectStatus,
  DEFAULT_FUND_TIMEOUT,
  DEFAULT_MIN_BALANCE,
  type Status,
} from '../core/status.js';
import { runSetupFlow, type FlowDeps, type SetupFlags, type StepEvent } from '../core/setupflow.js';
import { formatStatus } from './status.js';
import { buildContext } from './context.js';

function flagsFrom(parsed: ParsedArgs): SetupFlags {
  const minBalance = str(parsed.flags, 'min-balance') ?? DEFAULT_MIN_BALANCE;
  try {
    parseUnits(minBalance, 6);
  } catch {
    throw new X402Error(
      ExitCode.GENERIC,
      `--min-balance must be a decimal USDC amount, got ${minBalance}`,
    );
  }
  return {
    path: str(parsed.flags, 'path'),
    name: str(parsed.flags, 'name'),
    vaultPath: str(parsed.flags, 'vault'),
    keyFile: str(parsed.flags, 'key-file'),
    keystore: str(parsed.flags, 'keystore'),
    expires: str(parsed.flags, 'expires'),
    maxPerCall: str(parsed.flags, 'max-per-call'),
    dailyCap: str(parsed.flags, 'daily-cap'),
    telemetry: str(parsed.flags, 'telemetry'),
    orgKey: str(parsed.flags, 'org-key'),
    keyEnv: str(parsed.flags, 'key-env'),
    minBalance,
    fundTimeoutMs: parseDuration(str(parsed.flags, 'fund-timeout') ?? DEFAULT_FUND_TIMEOUT),
    yes: bool(parsed.flags, 'yes'),
    dryRun: bool(parsed.flags, 'dry-run'),
    printKey: bool(parsed.flags, 'print-key'),
    repay: bool(parsed.flags, 'repay'),
    install: bool(parsed.flags, 'install') || bool(parsed.flags, 'install-global'),
    // Only force the answer when the caller said something, as `wallet create` does.
    policy: bool(parsed.flags, 'policy')
      ? true
      : bool(parsed.flags, 'no-policy')
        ? false
        : undefined,
    replace: bool(parsed.flags, 'replace'),
  };
}

/** The proving endpoint, derived from the index the CLI already talks to. */
export function testUrlFor(indexUrl: string): string {
  return `${indexUrl.replace(/\/+$/, '')}/test/x402`;
}

/** One human line per step, and the status table at the end. Never the API key unless asked for. */
function humanEmitter(): (event: StepEvent) => void {
  return (event) => {
    const head = `${event.step.padEnd(14)} ${event.result.padEnd(8)} ${event.message}`;
    process.stdout.write(`${head}\n`);
    if (event.result === 'failed' && typeof event.resume === 'string') {
      process.stdout.write(`${' '.repeat(23)}${event.resume}\n`);
    }
    // Present only when the operator asked for it with --print-key or --key-env.
    if (event.step === 'store-key' && typeof event.apiKey === 'string') {
      process.stdout.write(`${' '.repeat(23)}api key: ${event.apiKey}\n`);
    }
    if (event.step === 'summary' && event.report) {
      process.stdout.write(`\n${formatStatus(event.report as Status)}`);
      const commands = event.commands as string[] | undefined;
      if (commands)
        process.stdout.write(`\nnext commands:\n${commands.map((c) => `  ${c}`).join('\n')}\n`);
    }
  };
}

export function realDeps(json: boolean): FlowDeps {
  const indexUrl = (() => {
    try {
      return loadConfig().config.discover.indexUrl;
    } catch {
      return 'https://api.roundhouseai.io/v0';
    }
  })();
  const testUrl = testUrlFor(indexUrl);
  const parsedStub: ParsedArgs = { command: 'setup', positionals: [], flags: {}, dataFlags: [] };

  return {
    interactive: interactive(),
    env: process.env,
    status: (minBalance) => collectStatus({ minBalance }),
    readRawConfig: () => readRawConfig(),
    writeConfig: (entries) => {
      writeConfig(entries);
    },
    createWallet: (opts) => runSetup(opts),
    globalInstallWritable: () => globalRootWritable(),
    mintPolicyKey: async () => {
      const { config } = loadConfig();
      const wallet = config.wallet.default;
      if (!wallet)
        throw new X402Error(ExitCode.GENERIC, 'no wallet is configured to mint a key for');
      const core = config.wallet.backends['ows-core'] ?? {};
      const grant = await grantPolicyKey({
        wallet,
        chains: [config.defaults.chain],
        ...(core.vaultPath ? { vaultPath: core.vaultPath } : {}),
        ...(core.passphrase ? { passphrase: core.passphrase } : {}),
      });
      return { id: grant.policy.id, keyId: grant.keyId, token: grant.token };
    },
    waitForFunds: async ({ address, chain, minAtomic, timeoutMs }) => {
      const config = loadConfig().config;
      return waitForBalance({
        minAtomic,
        timeoutMs,
        label: `${parseFloat((Number(minAtomic) / 1e6).toFixed(6))} USDC on ${chain} at ${address}`,
        read: async () => {
          const result = await readBalances(address, chain, { rpc: config.rpc, symbol: 'usdc' });
          const usdc = result.tokens.find((t) => t.symbol === 'usdc');
          if (!usdc) throw new Error(`no USDC contract is known on ${chain}`);
          return { amount: usdc.amount, atomic: BigInt(usdc.atomic) };
        },
        onProgress: (line) => {
          writeErr(line);
        },
      });
    },
    callTest: async ({ dryRun, noCache, max }) => {
      // Built fresh each time: the wallet and caps were written to config after
      // the first context would have been made.
      const ctx = buildContext(parsedStub);
      const result = await ctx.engine.call({
        target: testUrl,
        max,
        dryRun,
        noCache,
        wallet: ctx.walletName,
        signer: ctx.backendName,
        payloadLevel: ctx.payloadLevel,
      });
      await ctx.sink.flush();
      return {
        ok: result.ok,
        paid: result.paid,
        amount: result.amount,
        asset: result.asset,
        receiptId: result.receiptId,
        body: result.body,
        selected: result.selected
          ? {
              amount: result.selected.amount,
              assetSymbol: result.selected.assetSymbol,
              payTo: result.selected.payTo,
              network: result.selected.network,
            }
          : undefined,
        errorCode: result.errorCode,
        error: result.error,
      };
    },
    checkKey: async (key) => {
      try {
        const res = await request({
          url: `${indexUrl.replace(/\/+$/, '')}/account`,
          method: 'GET',
          headers: { accept: 'application/json', authorization: `Bearer ${key}` },
          timeoutMs: 10_000,
        });
        const body = parseJsonBody(res.body) as { key_recognised?: unknown } | undefined;
        if (body?.key_recognised === true) return 'recognised';
        if (body?.key_recognised === false) return 'rejected';
        return 'unknown';
      } catch {
        return 'unknown';
      }
    },
    emit: json ? (event) => writeCompactJson(event) : humanEmitter(),
    say: (line) => {
      process.stderr.write(`x402: ${line}\n`);
    },
    prompts: { ask, confirm, select },
    testUrl,
  };
}

/**
 * From nothing to a stored API key. Idempotent, resumable, and the same
 * decisions can be given as flags so it runs with no terminal at all.
 */
export async function setupCommand(parsed: ParsedArgs): Promise<number> {
  const flags = flagsFrom(parsed);
  return runSetupFlow(flags, realDeps(bool(parsed.flags, 'json')));
}
