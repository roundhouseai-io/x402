#!/usr/bin/env node
/**
 * The end-to-end check the unit tests deliberately cannot do.
 *
 * The suite stubs `fetch` and implements a fake `Signer`, which is right for
 * unit tests and leaves one thing unproven: that a *real* signature, from a
 * *real* OWS wallet, over a *real* 402, is one a facilitator would accept. That
 * is the part that costs money when it is wrong, so this runs on merge with the
 * optional peer dependencies actually installed:
 *
 *   1. create an OWS wallet through the bindings
 *   2. serve a mock x402 provider that demands payment
 *   3. drive `rh-x402 call` through the whole loop
 *   4. recover the signer from the EIP-712 signature and check it is the wallet
 *   5. check the authorization matches what was demanded, to the atomic unit
 *   6. check the idempotency cache does not sign twice
 *   7. check a rogue token contract is refused rather than signed
 *   8. check a chain the CLI does not pay on is refused rather than signed
 *
 * No network: every provider is a local server on an ephemeral port, and
 * nothing here reaches an RPC or a facilitator.
 *
 * Exits non-zero on the first failure, with what was expected and what happened.
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Asynchronous on purpose. The mock providers below run in *this* process, and
// `execFileSync` blocks the event loop for the whole child — so the server
// never accepts the connection and every call dies on the 30s timeout, which
// reads like a CLI hang rather than a harness bug.
const execFileAsync = promisify(execFile);

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ROGUE = '0xdeAdbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';
const PAY_TO = '0x0000000000000000000000000000000000001234';
const PASSPHRASE = 'integration-test-passphrase';
const AMOUNT_ATOMIC = '11000';

const home = mkdtempSync(join(tmpdir(), 'x402-int-'));
const vault = join(home, 'vault');
let failures = 0;

const check = (name, ok, detail = '') => {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}\n`);
  if (!ok) failures += 1;
};

const childEnv = (env) => ({
  ...process.env,
  X402_HOME: home,
  OWS_VAULT_PASS: PASSPHRASE,
  // The providers are on loopback and bypass a proxy anyway, but a CI runner
  // with a proxy set should not get to decide whether this test is hermetic.
  HTTPS_PROXY: '',
  https_proxy: '',
  HTTP_PROXY: '',
  http_proxy: '',
  ...env,
});

const run = (args, env = {}) =>
  execFileAsync('node', ['dist/cli.js', ...args], { encoding: 'utf8', env: childEnv(env) });

/** Run and parse the envelope; a non-zero exit throws with stderr attached. */
const cli = async (args, env = {}) => {
  try {
    return JSON.parse((await run(args, env)).stdout);
  } catch (err) {
    if (err.code === undefined) throw err;
    const detail = `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`.trim();
    throw new Error(`\`${args.join(' ')}\` exited ${err.code}\n${detail}`);
  }
};

/** Same, but a non-zero exit is the expected outcome rather than a crash. */
const cliExpectingFailure = async (args, env = {}) => {
  try {
    return { exitCode: 0, body: JSON.parse((await run(args, env)).stdout) };
  } catch (err) {
    if (err.code === undefined) throw err;
    let body = {};
    try {
      body = JSON.parse(String(err.stdout ?? '{}'));
    } catch {
      body = { error: String(err.stderr ?? '').trim() };
    }
    return { exitCode: err.code, body };
  }
};

/**
 * A provider that demands payment once, then serves the goods.
 *
 * Port 0, not a fixed one: two providers run in this script, a failed run
 * leaves a listener behind, and a CI runner has no idea what else is bound.
 * The 402 body quotes the port it actually got.
 */
function startProvider({
  asset = BASE_USDC,
  network = 'base',
  amount = AMOUNT_ATOMIC,
  extra = { name: 'USD Coin', version: '2' },
} = {}) {
  let seenPayment = null;
  const server = createServer((req, res) => {
    const payment = req.headers['x-payment'];
    const port = server.address().port;
    if (!payment) {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: 'exact',
              network,
              maxAmountRequired: amount,
              asset,
              payTo: PAY_TO,
              resource: `http://127.0.0.1:${port}/thing`,
              maxTimeoutSeconds: 300,
              extra,
            },
          ],
        }),
      );
      return;
    }
    seenPayment = JSON.parse(Buffer.from(payment, 'base64').toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answer: 'paid content' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Resolve on `listening`, not on the call: the first `call` below runs in a
    // child process, and a provider that is not yet accepting turns into a
    // connection-refused that reads like a CLI bug.
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}/thing`,
        seen: () => seenPayment,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(done);
          }),
      });
    });
  });
}

async function main() {
  const ows = await import('@open-wallet-standard/core');
  const { ethers } = await import('ethers');

  // 1. A real wallet in a real vault.
  const wallet = ows.createWallet('integration', PASSPHRASE, undefined, vault);
  const address = wallet.accounts.find((a) => a.chainId.startsWith('eip155:')).address;
  check('created an OWS wallet with an EVM account', Boolean(address), address);

  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      wallet: {
        backend: 'ows-core',
        default: 'integration',
        backends: { 'ows-core': { vaultPath: vault, passphrase: 'env:OWS_VAULT_PASS' } },
      },
      limits: { maxPerCall: '1.00' },
    }),
  );

  const checked = await cli(['signer', 'check']);
  check(
    'signer resolves and declares typed-data signing',
    checked.ok === true && checked.capabilities.typedData === true,
    JSON.stringify(checked.capabilities),
  );
  check('signer reports the vault address', checked.address === address, checked.address);

  // 2-3. The full loop against a provider that demands payment.
  const provider = await startProvider();
  try {
    const call = await cli(['call', provider.url, '--max', '0.05']);
    check(
      'call returned the paid body',
      call.ok === true && call.paid === true,
      JSON.stringify(call.body),
    );

    const payment = provider.seen();
    check('provider received an X-PAYMENT header', payment !== null);

    const auth = payment.payload.authorization;
    const signature = payment.payload.signature;

    // 4. The signature is the wallet's, over exactly this authorization.
    const recovered = ethers.verifyTypedData(
      { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_USDC },
      {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      auth,
      signature,
    );
    check(
      'signature recovers to the wallet address',
      recovered.toLowerCase() === address.toLowerCase(),
      `recovered ${recovered}, wallet ${address}`,
    );
    check('signature is 65 bytes, 0x-prefixed', /^0x[0-9a-fA-F]{130}$/.test(signature));

    // 5. It authorises what was demanded, and to whom.
    check('authorization pays the demanded amount', auth.value === AMOUNT_ATOMIC, auth.value);
    check('authorization pays the demanded recipient', auth.to.toLowerCase() === PAY_TO, auth.to);
    check('authorization is from the wallet', auth.from.toLowerCase() === address.toLowerCase());
    check('nonce is 32 bytes', /^0x[0-9a-fA-F]{64}$/.test(auth.nonce));
    check(
      'validBefore is in the future',
      Number(auth.validBefore) > Math.floor(Date.now() / 1000),
      auth.validBefore,
    );

    // 6. The double-payment defence.
    const again = await cli(['call', provider.url, '--max', '0.05']);
    const secondNonce = provider.seen().payload.authorization.nonce;
    check(
      'a repeat call reuses the cached authorization rather than signing again',
      secondNonce === auth.nonce,
      `first ${auth.nonce.slice(0, 18)}…, second ${secondNonce.slice(0, 18)}…`,
    );
    check('the repeat still returned the body', again.ok === true);
  } finally {
    await provider.close();
  }

  // 7. A rogue token contract is refused, not signed.
  const rogueProvider = await startProvider({ asset: ROGUE });
  try {
    const rogue = await cliExpectingFailure(['call', rogueProvider.url, '--max', '0.05']);
    check(
      'a 402 quoting an unknown asset does not produce a signature',
      rogue.exitCode !== 0 && rogueProvider.seen() === null,
      `exit ${rogue.exitCode}: ${String(rogue.body.error ?? '').slice(0, 90)}`,
    );
  } finally {
    await rogueProvider.close();
  }

  // 8. A price gate that cannot be rescaled by the counterparty.
  // 5e16 atomic units is 0.05 at the 18 decimals this provider declares, and
  // fifty billion at the 6 real USDC has. Taking the declared value would let
  // `--max 0.05` pass while reporting that it held.
  const liar = await startProvider({
    amount: '50000000000000000',
    extra: { name: 'USD Coin', version: '2', decimals: 18 },
  });
  try {
    const lied = await cliExpectingFailure(['call', liar.url, '--max', '0.05']);
    check(
      'a 402 that misdeclares the token decimals is refused, not priced on its word',
      lied.exitCode !== 0 && liar.seen() === null,
      `exit ${lied.exitCode}: ${String(lied.body.error ?? '').slice(0, 90)}`,
    );
  } finally {
    await liar.close();
  }

  // 9. A chain the CLI does not pay on is refused before anything is signed.
  // Ethereum is in the chain table so `wallet balance` can read it; that must
  // not make it selectable as a payment rail.
  const ethProvider = await startProvider({ network: 'ethereum', asset: ROGUE });
  try {
    const eth = await cliExpectingFailure(['call', ethProvider.url, '--max', '0.05']);
    check(
      'a 402 quoting ethereum is refused rather than paid',
      eth.exitCode !== 0 && ethProvider.seen() === null,
      `exit ${eth.exitCode}: ${String(eth.body.error ?? '').slice(0, 90)}`,
    );
  } finally {
    await ethProvider.close();
  }
}

const cleanup = () => rmSync(home, { recursive: true, force: true });

main()
  .then(() => {
    cleanup();
    process.stdout.write(
      failures === 0 ? '\nall integration checks passed\n' : `\n${failures} failed\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    cleanup();
    process.stderr.write(`integration run failed: ${err.stack ?? err}\n`);
    process.exit(1);
  });
