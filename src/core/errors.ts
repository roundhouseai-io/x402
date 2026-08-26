/**
 * Exit codes are a stability contract from v1. Agents branch on them.
 * Never renumber; only append.
 */
export const ExitCode = {
  /** Success (paid or free). */
  OK: 0,
  /** Generic / network error. Also used for usage errors. */
  GENERIC: 1,
  /** Invalid 402 payload (endpoint not x402-compliant). */
  INVALID_402: 40,
  /** Denied by OWS policy. */
  POLICY_DENIED: 42,
  /** Denied by payTo/domain allowlist. */
  ALLOWLIST_DENIED: 43,
  /** Price exceeds --max. */
  OVER_MAX: 44,
  /** Session budget or daily cap exhausted. */
  BUDGET_EXHAUSTED: 45,
  /** Insufficient wallet balance. */
  INSUFFICIENT_BALANCE: 46,
  /** OWS unreachable or auth failed. */
  OWS_UNREACHABLE: 47,
  /** Payment sent, but no valid response returned. Receipt logged. */
  PAID_NO_RESPONSE: 50,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** Stable machine-readable slug per exit code, surfaced as `error` in the envelope. */
export const ExitCodeName: Record<number, string> = {
  0: 'ok',
  1: 'error',
  40: 'invalid_402',
  42: 'policy_denied',
  43: 'allowlist_denied',
  44: 'over_max',
  45: 'budget_exhausted',
  46: 'insufficient_balance',
  47: 'ows_unavailable',
  50: 'paid_no_response',
};

export class X402Error extends Error {
  readonly code: ExitCodeValue;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: ExitCodeValue, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'X402Error';
    this.code = code;
    this.detail = detail;
  }

  get slug(): string {
    return ExitCodeName[this.code] ?? 'error';
  }
}

export const fail = (code: ExitCodeValue, message: string, detail?: Record<string, unknown>) =>
  new X402Error(code, message, detail);

export function exitCodeOf(err: unknown): ExitCodeValue {
  return err instanceof X402Error ? err.code : ExitCode.GENERIC;
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
