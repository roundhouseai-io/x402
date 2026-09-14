import { X402Error, ExitCode } from './errors.js';
import { parseUnits } from './assets.js';
import type { PaymentOption } from './x402.js';

export interface GateInput {
  option: PaymentOption;
  url: string;
  /** payTo allowlist. Empty means allow-all. */
  allowPayTo?: string[];
  /** Hostname allowlist. Empty means allow-all. Entries may be `*.example.com`. */
  allowDomains?: string[];
  /** Per-call cap, human decimal. A JSON number from config is accepted too. */
  maxPerCall?: string | number | undefined;
  /** Remaining session budget in atomic units of the option asset. */
  remainingBudgetAtomic?: bigint | undefined;
  /** Remaining daily cap in atomic units. */
  remainingDailyAtomic?: bigint | undefined;
}

export function domainAllowed(host: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const h = host.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase().trim();
    if (p === '') return false;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".example.com"
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return h === p;
  });
}

/**
 * Gate order per spec 5.4: payTo allowlist -> --max -> session budget -> daily
 * cap. First failure aborts. These are fail-fast conveniences; the OWS policy
 * engine remains the authoritative control.
 */
export function runGates(input: GateInput): void {
  const { option } = input;

  const host = safeHost(input.url);
  if (host && !domainAllowed(host, input.allowDomains ?? [])) {
    throw new X402Error(ExitCode.ALLOWLIST_DENIED, `domain not in allowlist: ${host}`);
  }

  const allowPayTo = (input.allowPayTo ?? []).map((a) => a.toLowerCase());
  if (allowPayTo.length > 0 && !allowPayTo.includes(option.payTo.toLowerCase())) {
    throw new X402Error(ExitCode.ALLOWLIST_DENIED, `payTo not in allowlist: ${option.payTo}`);
  }

  if (input.maxPerCall !== undefined && input.maxPerCall !== '') {
    let cap: bigint;
    try {
      cap = parseUnits(input.maxPerCall, option.decimals);
    } catch (err) {
      throw new X402Error(ExitCode.GENERIC, `invalid --max value: ${(err as Error).message}`);
    }
    if (option.amountAtomic > cap) {
      throw new X402Error(
        ExitCode.OVER_MAX,
        `quoted ${option.amount} ${option.assetSymbol} exceeds max ${String(input.maxPerCall)}`,
      );
    }
  }

  if (
    input.remainingBudgetAtomic !== undefined &&
    option.amountAtomic > input.remainingBudgetAtomic
  ) {
    throw new X402Error(
      ExitCode.BUDGET_EXHAUSTED,
      `session budget exhausted (need ${option.amount})`,
    );
  }

  if (
    input.remainingDailyAtomic !== undefined &&
    option.amountAtomic > input.remainingDailyAtomic
  ) {
    throw new X402Error(ExitCode.BUDGET_EXHAUSTED, `daily cap exhausted (need ${option.amount})`);
  }
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Process-lifetime spend tracker backing `--budget`. */
export class SessionBudget {
  private spent = 0n;
  constructor(private readonly capAtomic?: bigint) {}

  remaining(): bigint | undefined {
    return this.capAtomic === undefined ? undefined : this.capAtomic - this.spent;
  }

  record(atomic: bigint): void {
    this.spent += atomic;
  }

  get total(): bigint | undefined {
    return this.capAtomic;
  }
}
