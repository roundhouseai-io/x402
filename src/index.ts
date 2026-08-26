/**
 * Library surface. The CLI is the product; this export exists so `serve`,
 * tests, and embedders can drive the same engine.
 */
export { Engine, prepareRequest, inferMethod } from './core/engine.js';
export type { CallOptions, CallResult, EngineDeps, Receipt } from './core/engine.js';
export { ExitCode, ExitCodeName, X402Error } from './core/errors.js';
export type { ExitCodeValue } from './core/errors.js';
export { loadConfig, DEFAULT_CONFIG, mergeDeep, resolveEnv } from './core/config.js';
export type { X402Config, PayloadLevel } from './core/config.js';
export { parsePaymentRequired, selectOption } from './core/x402.js';
export type { PaymentOption, PaymentRequired } from './core/x402.js';
export {
  buildAuthorization,
  buildPaymentPayload,
  encodePaymentHeader,
  decodePaymentHeader,
  decodeSettlement,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from './core/eip3009.js';
export type { TypedData, PaymentPayload } from './core/eip3009.js';
export { OwsClient, OwsSigner, mapOwsError } from './core/ows.js';
export type { OwsWallet, OwsBalance } from './core/ows.js';
export type {
  SignerBackend,
  SignerFactory,
  SignerSelector,
  SignerAccount,
  SignerBalance,
  SignerCapabilities,
} from './core/signer.js';
export {
  resolveSigner,
  signerFactory,
  BUILTIN_BACKENDS,
  thirdPartyPackage,
} from './core/signers/index.js';
export { LocalSigner } from './core/signers/local.js';
export { ExecSigner, EXEC_PROTOCOL_VERSION, exitCodeForExecError } from './core/signers/exec.js';
export { readKeystore, addEntry, decryptEntry, findEntry, readKeyFile } from './core/keystore.js';
export type { KeystoreEntry, KeystoreFile } from './core/keystore.js';
export { runGates, SessionBudget, domainAllowed } from './core/gates.js';
export { authKey, readAuth, writeAuth, pruneAuthCache } from './core/authcache.js';
export type { AuthCacheEntry } from './core/authcache.js';
export {
  appendRecord,
  readRecords,
  queryRecords,
  sumRecords,
  spentToday,
  parseSince,
} from './core/ledger.js';
export type { LedgerRecord, HistoryQuery, GroupKey } from './core/ledger.js';
export {
  TelemetrySink,
  summarizePayload,
  summarizeHeaders,
  maskPaths,
  ALWAYS_REDACTED_HEADERS,
} from './core/telemetry.js';
export { buildData, parsePath, coerce, toQueryParams } from './core/data.js';
export { discover, resolveTarget, capabilityOf, filterByAllowlist } from './core/discover.js';
export type { Provider } from './core/discover.js';
export { formatUnits, parseUnits, findChain, findAsset, CHAINS, ASSETS } from './core/assets.js';
export { createServeServer, statusForCode } from './serve/http.js';
export { runMcpStdio, TOOLS as MCP_TOOLS } from './serve/mcp.js';
export { createToken, verifyToken, loadTokens, revokeToken } from './serve/tokens.js';
export type { CallerToken } from './serve/tokens.js';
export { toEnvelope } from './core/output.js';
export type { Envelope } from './core/output.js';
export { VERSION } from './version.js';
