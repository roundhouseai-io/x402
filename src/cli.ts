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
import { signerCommand } from './commands/signer.js';
import { serveCommand } from './commands/serve.js';

const HELP = `rh-x402 ${VERSION} — one command for the whole x402 payment loop

the command is rh-x402. this package deliberately ships no x402 binary: the
unscoped x402 package on npm is a different project that ships its own, and on
a machine with both the short name would be a coin toss.

usage
  rh-x402 <url> [flags]                  sugar for: rh-x402 call <url>
  rh-x402 call <url|x402:capability>     request, pay if a 402 is quoted, return the response
  rh-x402 probe <url>                    fetch payment requirements only; never pays
  rh-x402 pay <402-json|@file|->         build a signed X-PAYMENT header; no HTTP
  rh-x402 verify <receiptId|@file>       confirm settlement of a prior payment
  rh-x402 wallet create                  guided setup: pick a wallet, configure it
  rh-x402 wallet policy                  put an OWS policy in front of this wallet
  rh-x402 wallet <list|balance|address>  wallet queries against the signer backend
  rh-x402 history [urlSubstring]         query the local ledger
  rh-x402 discover <capability>          providers for a capability, cheapest first
  rh-x402 serve [--mcp]                  run the unified local endpoint
  rh-x402 serve token <create|list|revoke>
  rh-x402 signer <list|check>            inspect signer backends and capabilities
  rh-x402 signer keystore <list|add|generate>  manage the local development keystore
  rh-x402 config <get|set|list>          manage ~/.x402/config.json

wallet setup
  --path <ows|import|generate>        how the key is held; prompts when omitted
  --name <wallet>                     wallet name to create or adopt
  --install [--install-global]        permit installing the OWS bindings
  --vault <path>                      OWS vault location (default: ~/.ows)
  --key-file <path>                   for --path import; a 0600 file, never argv
  --policy / --no-policy              register an OWS policy and mint its key
  --chain <name>                      chains the policy allows (repeatable)
  --expires <30d|12h|ISO>             policy and key expiry

data
  --data.<path> <value>               nested data, e.g. --data.company.name "Roundhouse AI Ltd."
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
  -w, --wallet <name>                 wallet within the backend (default: config wallet.default)
      --signer <backend>              signer backend: ows | local | exec | x402-signer-<name>
      --max <amount>                  refuse if the quoted price exceeds this
      --budget <amount>               cumulative cap for this process
      --chain <name>                  acceptable chain (default base)
      --dry-run                       show what would be paid; do not sign
      --no-cache                      force a fresh authorization
      --receipt-out <file>            write the payment receipt JSON
      --telemetry-payload <level>     none | hash | full (default hash)

exit codes
  0 ok   1 error   40 invalid 402   42 signer policy   43 allowlist   44 over --max
  45 budget/daily cap   46 balance   47 signer unavailable   50 paid, no valid response

start here
  rh-x402 discover web-search            works with no config: the Roundhouse index
                                      is the built-in default

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
    case 'signer':
      return signerCommand(parsed);
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
