import type { X402Config } from './config.js';

/**
 * The Roundhouse API key: where it may be sent, and how it is kept out of output.
 *
 * `auth.apiKey` exists so keyed Roundhouse endpoints can be called without the
 * key being pasted into every command. That convenience is also the risk: a
 * bearer credential attached to every outgoing request is a credential handed to
 * whatever host the request names. So it is sent to Roundhouse hosts and only
 * Roundhouse hosts, over https, and never overrides an `Authorization` header
 * the caller wrote themselves.
 */

export const ROUNDHOUSE_APEX = 'roundhouseai.io';

export const REDACTED = '[redacted]';

/** Whether `url` is an https endpoint on the Roundhouse zone. */
export function isRoundhouseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === ROUNDHOUSE_APEX || host.endsWith(`.${ROUNDHOUSE_APEX}`);
}

/** The `Authorization` header to add to a request for `url`, or nothing. */
export function authHeaders(
  url: string,
  config: Pick<X402Config, 'auth'>,
  explicit: Record<string, string> = {},
): Record<string, string> {
  const key = config.auth.apiKey;
  if (!key || !isRoundhouseUrl(url)) return {};
  if (Object.keys(explicit).some((name) => name.toLowerCase() === 'authorization')) return {};
  return { authorization: `Bearer ${key}` };
}

/** The config with the API key, if any, replaced so it can be printed. */
export function redactConfig(config: X402Config): X402Config {
  if (!config.auth.apiKey) return config;
  return { ...config, auth: { ...config.auth, apiKey: REDACTED } };
}
