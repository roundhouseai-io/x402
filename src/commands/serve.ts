import { X402Error, ExitCode } from '../core/errors.js';
import { writeJson, isTty } from '../core/output.js';
import { bool, num, str, type ParsedArgs } from '../core/args.js';
import { buildContext } from './context.js';
import { createServeServer } from '../serve/http.js';
import { runMcpStdio } from '../serve/mcp.js';
import { createToken, loadTokens, revokeToken } from '../serve/tokens.js';
import { VERSION } from '../version.js';

/**
 * Run the engine as a long-lived local service: HTTP gateway, optional MCP
 * server. Also hosts `serve token …` for caller tokens.
 */
export async function serveCommand(parsed: ParsedArgs): Promise<number> {
  if (parsed.positionals[0] === 'token') return tokenSubcommand(parsed);

  const ctx = buildContext(parsed);
  const host = str(parsed.flags, 'host') ?? ctx.config.serve.host;
  const port = num(parsed.flags, 'port') ?? ctx.config.serve.port;

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    if (!bool(parsed.flags, 'i-understand-this-exposes-spending')) {
      throw new X402Error(
        ExitCode.GENERIC,
        `binding to ${host} exposes wallet spending to the network. ` +
          `Pass --i-understand-this-exposes-spending and terminate TLS in front of it, ` +
          `or keep the default 127.0.0.1 bind.`,
      );
    }
    process.stderr.write(
      `x402: WARNING serving on ${host}:${port}. Anything that reaches this port can spend from ` +
        `wallet "${ctx.walletName ?? '(none)'}". Put it behind your own gateway.\n`,
    );
  }

  if (bool(parsed.flags, 'mcp')) {
    // stdio MCP owns stdout, so nothing else may print there.
    process.stderr.write(`x402: MCP server on stdio (x402 v${VERSION})\n`);
    await runMcpStdio({ engine: ctx.engine, config: ctx.config, version: VERSION });
    await ctx.sink.flush();
    return ExitCode.OK;
  }

  const server = createServeServer({
    engine: ctx.engine,
    config: ctx.config,
    ows: ctx.ows,
    host,
    port,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const tokens = loadTokens().tokens.filter((t) => !t.revokedAt);
  process.stderr.write(
    `x402: serving on http://${host}:${port} (wallet ${ctx.walletName ?? 'none'}, ` +
      `${tokens.length} caller token${tokens.length === 1 ? '' : 's'})\n`,
  );
  if (tokens.length === 0) {
    process.stderr.write(
      `x402: no caller tokens exist yet; every request will be rejected. ` +
        `Mint one: x402 serve token create <name> --budget-daily 1.00 --max-per-call 0.01\n`,
    );
  }

  const flushTimer = setInterval(
    () => void ctx.sink.flush(),
    ctx.config.telemetry.sink.batchIntervalMs,
  );
  flushTimer.unref();

  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(flushTimer);
      server.close(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  await ctx.sink.flush();
  return ExitCode.OK;
}

function tokenSubcommand(parsed: ParsedArgs): number {
  const action = parsed.positionals[1];

  if (action === 'create') {
    const name = parsed.positionals[2];
    if (!name) {
      throw new X402Error(
        ExitCode.GENERIC,
        'usage: x402 serve token create <name> [--budget-daily 1.00] [--max-per-call 0.01] [--capabilities a,b] [--admin]',
      );
    }
    const capabilities = str(parsed.flags, 'capabilities')
      ?.split(',')
      .map((c) => c.trim())
      .filter((c) => c !== '');
    const { token, plaintext } = createToken({
      name,
      budgetDaily: str(parsed.flags, 'budget-daily'),
      maxPerCall: str(parsed.flags, 'max-per-call'),
      capabilities,
      admin: bool(parsed.flags, 'admin'),
    });
    if (isTty()) {
      process.stdout.write(`${plaintext}\n`);
      process.stderr.write(
        `x402: token "${name}" created. This is the only time it is shown; only its hash is stored.\n`,
      );
    } else {
      writeJson({
        ok: true,
        token: plaintext,
        name: token.name,
        limits: {
          budgetDaily: token.budgetDaily ?? null,
          maxPerCall: token.maxPerCall ?? null,
          capabilities: token.capabilities ?? null,
          admin: token.admin === true,
        },
      });
    }
    return ExitCode.OK;
  }

  if (action === 'list') {
    const tokens = loadTokens().tokens.map((t) => ({
      ...t,
      hash: `sha256:${t.hash.slice(0, 12)}…`,
    }));
    if (isTty()) {
      if (tokens.length === 0) process.stdout.write('no caller tokens\n');
      for (const t of tokens) {
        process.stdout.write(
          `${t.revokedAt ? 'revoked' : 'active '} ${t.name.padEnd(20)} daily ${t.budgetDaily ?? '-'} ` +
            `per-call ${t.maxPerCall ?? '-'}${t.admin ? ' admin' : ''}\n`,
        );
      }
    } else {
      writeJson({ ok: true, tokens });
    }
    return ExitCode.OK;
  }

  if (action === 'revoke') {
    const name = parsed.positionals[2];
    if (!name) throw new X402Error(ExitCode.GENERIC, 'usage: x402 serve token revoke <name>');
    const revoked = revokeToken(name);
    if (!isTty()) writeJson({ ok: revoked, name });
    else process.stdout.write(revoked ? `revoked ${name}\n` : `no live token named ${name}\n`);
    return revoked ? ExitCode.OK : ExitCode.GENERIC;
  }

  throw new X402Error(ExitCode.GENERIC, 'usage: x402 serve token <create|list|revoke>');
}
