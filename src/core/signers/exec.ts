import { spawn } from 'node:child_process';
import { X402Error, ExitCode, messageOf, type ExitCodeValue } from '../errors.js';
import {
  isJsonObject,
  isString,
  objectField,
  parseJson,
  stringField,
  type JsonObject,
  type JsonValue,
} from '../json.js';
import type { ExecBackendConfig } from '../config.js';
import type { TypedData } from '../eip3009.js';
import type { SignerAccount, SignerBackend, SignerBalance, SignerCapabilities } from '../signer.js';

/**
 * External signer protocol: any executable that speaks JSON over stdio, in the
 * style of git credential helpers. This is the escape hatch that keeps the tool
 * genuinely wallet-agnostic — a hardware bridge, an MPC service, a KMS wrapper
 * or a bespoke corporate signer is one small executable away, in any language.
 *
 * The protocol is documented in docs/exec-signer.md. One process per request,
 * one JSON line in, one JSON line out; stderr is passed through so a helper can
 * tell the operator what it wants.
 */
export const EXEC_PROTOCOL_VERSION = 1;

export type ExecMethod = 'capabilities' | 'getAccounts' | 'getAddress' | 'signTypedData';

/** What a method call carries. `wallet` is always set; the rest per method. */
interface ExecParams {
  wallet?: string;
  chain?: string;
  typedData?: TypedData;
}

interface ExecRequest {
  x402Signer: number;
  id: string;
  method: ExecMethod;
  params: ExecParams;
}

/** Helper error codes map onto the CLI's taxonomy. */
export function exitCodeForExecError(code: string | undefined): ExitCodeValue {
  switch ((code ?? '').toLowerCase()) {
    case 'policy_denied':
    case 'denied':
      return ExitCode.POLICY_DENIED;
    case 'insufficient_balance':
      return ExitCode.INSUFFICIENT_BALANCE;
    case 'unsupported':
    case 'unavailable':
    case 'auth_failed':
      return ExitCode.OWS_UNREACHABLE;
    default:
      return ExitCode.GENERIC;
  }
}

export class ExecSigner implements SignerBackend {
  readonly backend = 'exec';
  private caps: SignerCapabilities | undefined;

  constructor(
    readonly wallet: string,
    private readonly config: ExecBackendConfig,
  ) {
    if (!config.command) {
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        'exec signer backend needs wallet.backends.exec.command',
      );
    }
  }

  /** One request/response round trip. Resolves to the response's `result` object. */
  private async call(method: ExecMethod, params: ExecParams = {}): Promise<JsonObject> {
    const request: ExecRequest = {
      x402Signer: EXEC_PROTOCOL_VERSION,
      id: `${Date.now().toString(36)}`,
      method,
      params: { wallet: this.wallet, ...params },
    };
    const timeoutMs = this.config.timeoutMs ?? 30_000;

    const output = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn(this.config.command, this.config.args ?? [], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new X402Error(
            ExitCode.OWS_UNREACHABLE,
            `exec signer ${this.config.command} timed out after ${timeoutMs}ms on ${method}`,
          ),
        );
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new X402Error(
            ExitCode.OWS_UNREACHABLE,
            `cannot run exec signer ${this.config.command}: ${err.message}`,
          ),
        );
      });
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && stdout.trim() === '') {
          reject(
            new X402Error(
              ExitCode.OWS_UNREACHABLE,
              `exec signer ${this.config.command} exited ${code} without a response`,
            ),
          );
          return;
        }
        resolvePromise(stdout);
      });

      child.stdin.end(`${JSON.stringify(request)}\n`);
    });

    const line = output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .pop();
    if (!line) {
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        `exec signer ${this.config.command} returned no JSON response for ${method}`,
      );
    }

    let parsed: JsonValue;
    try {
      parsed = parseJson(line);
    } catch (err) {
      throw new X402Error(
        ExitCode.OWS_UNREACHABLE,
        `exec signer returned invalid JSON: ${messageOf(err)}`,
      );
    }
    // `line` starts with `{`, so a successful parse is an object.
    const response = isJsonObject(parsed) ? parsed : {};
    const error = objectField(response, 'error');
    if (error) {
      const code = stringField(error, 'code');
      throw new X402Error(
        exitCodeForExecError(code),
        `exec signer refused ${method}: ${stringField(error, 'message') ?? code ?? 'no reason given'}`,
      );
    }
    return objectField(response, 'result') ?? {};
  }

  async capabilities(): Promise<SignerCapabilities> {
    if (this.caps) return this.caps;
    const result = await this.call('capabilities');
    this.caps = {
      typedData: result.typedData === true,
      policies: result.policies === true,
      balances: result.balances === true,
      accounts: result.accounts === true,
      declared: true,
    };
    return this.caps;
  }

  async getAccounts(): Promise<SignerAccount[]> {
    const result = await this.call('getAccounts');
    const accounts = Array.isArray(result.accounts) ? result.accounts : [];
    return accounts.filter(isJsonObject).map((a) => ({
      id: String(a.id ?? a.name ?? ''),
      address: String(a.address ?? ''),
      chains: Array.isArray(a.chains) ? a.chains.map(String) : undefined,
    }));
  }

  async getAddress(chain?: string): Promise<string> {
    const result = await this.call('getAddress', chain ? { chain } : {});
    const address = result.address;
    if (!isString(address) || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new X402Error(ExitCode.OWS_UNREACHABLE, 'exec signer returned no usable address');
    }
    return address;
  }

  async signTypedData(typedData: TypedData): Promise<string> {
    const result = await this.call('signTypedData', { typedData });
    const signature = result.signature;
    if (!isString(signature) || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      throw new X402Error(ExitCode.OWS_UNREACHABLE, 'exec signer returned no signature');
    }
    return signature;
  }

  async getBalance(asset: string, chain: string): Promise<SignerBalance | undefined> {
    void asset;
    void chain;
    // Balances are not part of the exec protocol; the pre-flight check is skipped.
    return undefined;
  }
}
