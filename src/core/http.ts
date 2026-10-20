import { X402Error, ExitCode, messageOf } from './errors.js';
import { domainAllowed } from './gates.js';
import { isJsonObject, isString, parseJson, type JsonObject, type JsonValue } from './json.js';
import { ProxyTunnelAgent, bypassesProxy, proxyFromEnv, type ProxyConfig } from './proxy.js';

/** How many same-origin hops one call will follow before it gives up. */
const MAX_REDIRECTS = 5;

/** Header name -> value, names lower-cased on responses. */
export interface HeaderMap {
  [name: string]: string;
}

export interface HttpRequest {
  url: string;
  method: string;
  headers: HeaderMap;
  body?: string | undefined;
  timeoutMs: number;
  /**
   * Domain allowlist (`example.com`, `*.example.com`) checked against every
   * redirect target. Empty or absent allows any host, which is what an empty
   * config allowlist means. A cross-origin redirect is refused either way.
   */
  allowDomains?: string[] | undefined;
}

export interface HttpResponse {
  /** URL that produced this response, after any same-origin redirects. */
  url: string;
  /** Method of the request that produced this response. */
  method: string;
  status: number;
  headers: HeaderMap;
  body: string;
  bytes: number;
  latencyMs: number;
}

/**
 * Send one request through a CONNECT tunnel, for when a proxy is configured.
 *
 * `fetch` cannot take an agent, so the proxied path uses `node:https` directly.
 * Same shape in and out as the direct path, so nothing above here has to know
 * which route a request took.
 */
async function requestViaProxy(req: HttpRequest, proxy: ProxyConfig): Promise<HttpResponse> {
  const { request: httpsRequest } = await import('node:https');
  const url = new URL(req.url);
  const started = Date.now();
  const agent = new ProxyTunnelAgent(proxy.url);

  return new Promise<HttpResponse>((resolve, reject) => {
    const out = httpsRequest(
      {
        host: url.hostname,
        port: Number(url.port || 443),
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: req.headers,
        agent,
        timeout: req.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const headers: HeaderMap = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (isString(v)) headers[k.toLowerCase()] = v;
            else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
          }
          resolve({
            url: req.url,
            method: req.method,
            status: res.statusCode ?? 0,
            headers,
            body,
            bytes: Buffer.byteLength(body),
            latencyMs: Date.now() - started,
          });
        });
        res.on('error', reject);
      },
    );
    out.once('timeout', () => {
      out.destroy(new Error(`request timed out after ${req.timeoutMs}ms`));
    });
    out.once('error', reject);
    if (req.body !== undefined) out.write(req.body);
    out.end();
  });
}

/**
 * Say which route a failed request took, when a proxy is in play.
 *
 * Getting this wrong is worse than saying nothing: a note that the proxy was
 * used, on a request that bypassed it, sends the reader to debug the wrong hop.
 * So the caller passes what actually happened rather than the hint inferring it
 * from the environment.
 */
export function proxyHint(used: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const proxy = proxyFromEnv(env);
  if (!proxy) return '';
  if (used) return ` Routed through the proxy at ${proxy.url}.`;
  return (
    ` A proxy is set (${proxy.url}) but this host bypassed it` +
    ' (loopback, or a NO_PROXY entry), so the request went direct.'
  );
}

/**
 * One HTTP call. Redirects are not handed to `fetch`.
 *
 * Same-origin redirects are followed, and each target is checked against
 * `allowDomains`. A cross-origin redirect is refused before the next request
 * is made, so a payment header is never sent to, and a 402 is never signed
 * for, an origin other than the one that was requested. Call that other URL
 * directly if it is the one you mean to pay; the domain allowlist then sees it.
 */
export async function request(req: HttpRequest): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  const started = Date.now();
  let viaProxy = false;
  let url = req.url;
  let method = req.method;
  let headers = req.headers;
  let body = req.body;
  try {
    for (let hop = 0; ; hop += 1) {
      const sent = await sendOnce(
        { url, method, headers, body, timeoutMs: req.timeoutMs },
        controller.signal,
      );
      if (sent.viaProxy) viaProxy = true;
      const next = nextHop(url, method, headers, body, sent.response, req.allowDomains);
      if (!next) {
        return { ...sent.response, url, method, latencyMs: Date.now() - started };
      }
      if (hop >= MAX_REDIRECTS) {
        throw new X402Error(
          ExitCode.GENERIC,
          `stopped after ${MAX_REDIRECTS} redirects at ${url}`,
          { url, transient: true },
        );
      }
      url = next.url;
      method = next.method;
      headers = next.headers;
      body = next.body;
    }
  } catch (err) {
    if (err instanceof X402Error) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new X402Error(ExitCode.GENERIC, `request timed out after ${req.timeoutMs}ms`, {
        url,
        timeoutMs: req.timeoutMs,
        transient: true,
      });
    }
    const detail: JsonObject = { url, transient: true };
    // undici reports the socket-level reason (ECONNREFUSED, ENOTFOUND) as `cause.code`.
    const code = err instanceof Error ? causeCode(err.cause) : undefined;
    if (code !== undefined) detail.cause = code;
    throw new X402Error(
      ExitCode.GENERIC,
      `network error: ${messageOf(err)}.${proxyHint(viaProxy)}`,
      detail,
    );
  } finally {
    clearTimeout(timer);
  }
}

interface Sent {
  response: HttpResponse;
  viaProxy: boolean;
}

interface Hop {
  url: string;
  method: string;
  headers: HeaderMap;
  body: string | undefined;
}

/** One hop, with `redirect: 'manual'` so `fetch` cannot leave this origin on its own. */
async function sendOnce(
  req: Pick<HttpRequest, 'url' | 'method' | 'headers' | 'body' | 'timeoutMs'>,
  signal: AbortSignal,
): Promise<Sent> {
  const url = new URL(req.url);
  const proxy = proxyFromEnv();
  // Only HTTPS goes through the tunnel: CONNECT is how a proxy carries TLS, and
  // everything this CLI talks to is HTTPS except a loopback OWS, which bypasses.
  if (
    proxy &&
    url.protocol === 'https:' &&
    !bypassesProxy(url.hostname, Number(url.port || 443), proxy.noProxy)
  ) {
    return { response: await requestViaProxy(req, proxy), viaProxy: true };
  }

  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'manual',
    signal,
  });
  const text = await res.text();
  const headers: HeaderMap = {};
  res.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return {
    viaProxy: false,
    response: {
      url: req.url,
      method: req.method,
      status: res.status,
      headers,
      body: text,
      bytes: Buffer.byteLength(text),
      latencyMs: 0,
    },
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function originPort(url: URL): string {
  if (url.port !== '') return url.port;
  if (url.protocol === 'https:') return '443';
  if (url.protocol === 'http:') return '80';
  return '';
}

function sameOrigin(a: URL, b: URL): boolean {
  return (
    a.protocol === b.protocol &&
    a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
    originPort(a) === originPort(b)
  );
}

/**
 * Refuse a redirect that would carry this request somewhere else.
 *
 * Same origin is required even when the target host is on the allowlist: the
 * allowlist is re-checked here, and a different origin is still not paid.
 * The caller can request that origin itself, which is when the allowlist
 * decides.
 */
function assertRedirectAllowed(
  from: string,
  target: URL,
  allowDomains: string[] | undefined,
): void {
  const source = new URL(from);
  const patterns = allowDomains ?? [];
  const listed = patterns.length === 0 || domainAllowed(target.hostname, patterns);
  if (!sameOrigin(source, target)) {
    const why = listed
      ? 'call that URL directly if it is the one you mean to pay'
      : `${target.hostname} is not in the domain allowlist`;
    throw new X402Error(
      listed ? ExitCode.GENERIC : ExitCode.ALLOWLIST_DENIED,
      `refusing cross-origin redirect from ${source.origin} to ${target.origin}; ${why}`,
      { url: from, redirectTo: target.toString() },
    );
  }
  if (!listed) {
    throw new X402Error(
      ExitCode.ALLOWLIST_DENIED,
      `redirect target not in allowlist: ${target.hostname}`,
      { url: from, redirectTo: target.toString() },
    );
  }
}

/** 301/302/303 of a non-GET become GET and drop the body, matching fetch. */
function becomesGet(status: number, method: string): boolean {
  if (status === 307 || status === 308) return false;
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'HEAD';
}

function withoutBodyHeaders(headers: HeaderMap): HeaderMap {
  const next: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'content-type' || lower === 'content-length' || lower === 'transfer-encoding') {
      continue;
    }
    next[name] = value;
  }
  return next;
}

/** The next same-origin hop, or nothing when `res` is the response to keep. */
function nextHop(
  from: string,
  method: string,
  headers: HeaderMap,
  body: string | undefined,
  res: HttpResponse,
  allowDomains: string[] | undefined,
): Hop | undefined {
  if (!isRedirect(res.status)) return undefined;
  const location = res.headers.location;
  if (!isString(location) || location.trim() === '') return undefined;
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return undefined;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return undefined;
  assertRedirectAllowed(from, target, allowDomains);
  if (becomesGet(res.status, method)) {
    return {
      url: target.toString(),
      method: 'GET',
      headers: withoutBodyHeaders(headers),
      body: undefined,
    };
  }
  return { url: target.toString(), method, headers, body };
}

/** The `code` of an error's `cause`, when it has a string one. */
function causeCode(cause: unknown): string | undefined {
  return isJsonObject(cause) && isString(cause.code) ? cause.code : undefined;
}

export function parseJsonBody(body: string): JsonValue | undefined {
  if (body.trim() === '') return undefined;
  try {
    return parseJson(body);
  } catch {
    return undefined;
  }
}

export function isJsonResponse(headers: HeaderMap): boolean {
  const ct = headers['content-type'] ?? '';
  return ct.includes('json');
}
