import { isString, type JsonObject } from './json.js';

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
  /** `wallet balance --wait` ran out of time before the balance arrived. */
  WAIT_TIMEOUT: 48,
  /** Payment sent, but no valid response returned. Receipt logged. */
  PAID_NO_RESPONSE: 50,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** Stable machine-readable slug per exit code, surfaced as `error` in the envelope. */
/** Exit code -> its stable slug. */
export interface ExitCodeNames {
  [code: number]: string;
}

export const ExitCodeName: ExitCodeNames = {
  0: 'ok',
  1: 'error',
  40: 'invalid_402',
  42: 'policy_denied',
  43: 'allowlist_denied',
  44: 'over_max',
  45: 'budget_exhausted',
  46: 'insufficient_balance',
  47: 'ows_unavailable',
  48: 'wait_timeout',
  50: 'paid_no_response',
};

export interface ExitCodeRow {
  code: number;
  name: string;
  /** What happened, in one clause. */
  meaning: string;
  /** What the caller should do, in one clause. This is the column agents act on. */
  next: string;
}

/**
 * The one table. `rh-x402 help exit-codes` prints it, the help footer is built
 * from it and `SKILL.md` carries it verbatim (a test fails if they drift), so
 * the wording that says what to do after a failure is written once.
 */
export const EXIT_CODE_TABLE: readonly ExitCodeRow[] = [
  { code: 0, name: 'ok', meaning: 'Success, paid or free', next: 'Use the body.' },
  {
    code: 1,
    name: 'error',
    meaning: 'Generic, network or usage error. Nothing was paid.',
    next: 'Read the message. A network error is safe to retry.',
  },
  {
    code: 40,
    name: 'invalid_402',
    meaning: 'The endpoint answered a 402 this CLI cannot use, or rejected a valid authorization',
    next: 'Do not retry. Report the endpoint.',
  },
  {
    code: 42,
    name: 'policy_denied',
    meaning: 'The wallet policy refused to sign',
    next: 'Stop. A human must widen the wallet policy.',
  },
  {
    code: 43,
    name: 'allowlist_denied',
    meaning: 'An allowlist excluded this domain or payee',
    next: 'Stop. The provider is not approved.',
  },
  {
    code: 44,
    name: 'over_max',
    meaning: 'The quoted price is above --max or limits.maxPerCall',
    next: 'Probe for the live price. Raise --max only if a human allowed it.',
  },
  {
    code: 45,
    name: 'budget_exhausted',
    meaning: '--budget for this process or limits.dailyCap is spent',
    next: 'Stop spending and report it.',
  },
  {
    code: 46,
    name: 'insufficient_balance',
    meaning: 'The wallet cannot cover the quoted price',
    next: 'Stop. Fund the wallet, then run `wallet balance --wait`.',
  },
  {
    code: 47,
    name: 'ows_unavailable',
    meaning: 'The signer is unreachable, rejected its credential, or cannot sign typed data',
    next: 'Read the message. If it names a missing package, install it. Otherwise retry once, then report the wallet layer as down.',
  },
  {
    code: 48,
    name: 'wait_timeout',
    meaning: '`wallet balance --wait` timed out before the balance arrived',
    next: 'Check the address and chain with the human, then wait again or report it.',
  },
  {
    code: 50,
    name: 'paid_no_response',
    meaning: 'The payment was sent and no valid response came back. Money may have moved.',
    next: 'Re-run the identical command. Never add --no-cache.',
  },
];

/** The table as markdown, for the docs that copy it. */
export function exitCodesMarkdown(): string {
  const cell = (text: string): string => text.replace(/\|/g, '\\|');
  const rows = EXIT_CODE_TABLE.map(
    (r) => `| ${r.code} | \`${r.name}\` | ${cell(r.meaning)} | ${cell(r.next)} |`,
  );
  return ['| Code | Name | Meaning | What to do next |', '| --- | --- | --- | --- |', ...rows].join(
    '\n',
  );
}

/** The table as aligned text, for a terminal. */
export function exitCodesText(): string {
  const nameWidth = Math.max(...EXIT_CODE_TABLE.map((r) => r.name.length));
  return EXIT_CODE_TABLE.map(
    (r) =>
      `${String(r.code).padStart(2)}  ${r.name.padEnd(nameWidth)}  ${r.meaning}\n${' '.repeat(4 + nameWidth)}-> ${r.next}`,
  ).join('\n');
}

export class X402Error extends Error {
  readonly code: ExitCodeValue;
  /** Machine-readable context, printed as `detail` in the JSON error envelope. */
  readonly detail: JsonObject | undefined;

  constructor(code: ExitCodeValue, message: string, detail?: JsonObject) {
    super(message);
    this.name = 'X402Error';
    this.code = code;
    this.detail = detail;
  }

  get slug(): string {
    return ExitCodeName[this.code] ?? 'error';
  }
}

export const fail = (code: ExitCodeValue, message: string, detail?: JsonObject) =>
  new X402Error(code, message, detail);

// `cause` is a caught exception or a rejection reason, which really can be
// any value; these two are what every `catch` hands it to.
export function exitCodeOf(cause: unknown): ExitCodeValue {
  return cause instanceof X402Error ? cause.code : ExitCode.GENERIC;
}

/** The `code` of a Node system error (`ENOENT`, `EACCES`), when it has one. */
export function errnoCode(cause: unknown): string | undefined {
  return cause instanceof Error && 'code' in cause && isString(cause.code) ? cause.code : undefined;
}

export function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
