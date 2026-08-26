#!/usr/bin/env node
import { parseArgs, bool, type ParsedArgs } from './core/args.js';
import { ExitCode, ExitCodeName, exitCodeOf, messageOf, X402Error } from './core/errors.js';
import { writeErr, writeJson, isTty } from './core/output.js';
import { VERSION } from './version.js';
import { callCommand, probeCommand } from './commands/call.js';
import { payCommand } from './commands/pay.js';
import { verifyCommand } from './commands/verify.js';
import { walletCommand } from './commands/wallet.js';
import { historyCommand } from './commands/history.js';
import { discoverCommand } from './commands/discover.js';
import { configCommand } from './commands/config.js';
import { serveCommand } from './commands/serve.js';

const HELP = `x402 ${VERSION} — one command for the whole x402 payment loop

usage
  x402 <url> [flags]                  sugar for: x402 call <url>
  x402 call <url|x402:capability>     request, pay if a 402 is quoted, return the response
  x402 probe <url>                    fetch payment requirements only; never pays
  x402 pay <402-json|@file|->         build a signed X-PAYMENT header; no HTTP
  x402 verify <receiptId|@file>       confirm settlement of a prior payment
  x402 wallet <list|balance|address>  passthrough to OWS
  x402 history [urlSubstring]         query the local ledger
  x402 discover <capability>          providers for a capability, cheapest first
  x402 serve [--mcp]                  run the unified local endpoint
  x402 serve token <create|list|revoke>
  x402 config <get|set|list>          manage ~/.x402/config.json

data
  --data.<path> <value>               nested data, e.g. --data.company.name "Amplify Limited"
                                      --data.checks[0] sanctions  (dots for objects, [n] for arrays)
  --json '<json>' | @file | -         JSON blob from argv, a file, or stdin
  --data-strings                      disable type coercion for the whole call
                                      (or prefix one value: --data.postcode str:10001)

request
  -X, --method <verb>                 HTTP method (default: inferred; data implies POST)
  -H, --header "K: V"                 extra header, repeatable
      --timeout <seconds>             total timeout (default 30)
      --out <file>                    write the response body to a file
      --raw                           print the body alone, no envelope
      --form                          send POST data as x-www-form-urlencoded
      --body-always                   force a body on GET/HEAD/DELETE

payment
  -w, --wallet <name>                 OWS wallet (default: config wallet.default)
      --max <amount>                  refuse if the quoted price exceeds this
      --budget <amount>               cumulative cap for this process
      --chain <name>                  acceptable chain (default base)
      --dry-run                       show what would be paid; do not sign
      --no-cache                      force a fresh authorization
      --receipt-out <file>            write the payment receipt JSON
      --telemetry-payload <level>     none | hash | full (default hash)

exit codes
  0 ok   1 error   40 invalid 402   42 OWS policy   43 allowlist   44 over --max
  45 budget/daily cap   46 balance   47 OWS unreachable   50 paid, no valid response

docs  https://github.com/roundhouseai-io/x402
`;

async function run(parsed: ParsedArgs): Promise<number> {
  switch (parsed.command) {
    case 'call':
      return callCommand(parsed);
    case 'probe':
      return probeCommand(parsed);
    case 'pay':
      return payCommand(parsed);
    case 'verify':
      return verifyCommand(parsed);
    case 'wallet':
      return walletCommand(parsed);
    case 'history':
      return historyCommand(parsed);
    case 'discover':
      return discoverCommand(parsed);
    case 'serve':
      return serveCommand(parsed);
    case 'config':
      return configCommand(parsed);
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return ExitCode.OK;
    case 'help':
    case undefined:
      process.stdout.write(HELP);
      return parsed.positionals.length === 0 && parsed.command === undefined
        ? ExitCode.GENERIC
        : ExitCode.OK;
    default:
      throw new X402Error(ExitCode.GENERIC, `unknown command: ${parsed.command}`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return reportError(err);
  }

  if (bool(parsed.flags, 'version')) {
    process.stdout.write(`${VERSION}\n`);
    return ExitCode.OK;
  }
  if (bool(parsed.flags, 'help')) {
    process.stdout.write(HELP);
    return ExitCode.OK;
  }

  try {
    return await run(parsed);
  } catch (err) {
    return reportError(err);
  }
}

function reportError(err: unknown): number {
  const code = exitCodeOf(err);
  const message = messageOf(err);
  if (isTty()) {
    writeErr(message);
  } else {
    writeJson({
      ok: false,
      errorCode: code,
      errorName: ExitCodeName[code] ?? 'error',
      error: message,
      ...(err instanceof X402Error && err.detail ? { detail: err.detail } : {}),
    });
  }
  return code;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url.endsWith('/cli.js') || import.meta.url.endsWith('/cli.ts'));

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`x402: ${messageOf(err)}\n`);
      process.exitCode = ExitCode.GENERIC;
    },
  );
}
