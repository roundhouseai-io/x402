import { X402Error, ExitCode } from './errors.js';
import { ProxyTunnelAgent, bypassesProxy, proxyFromEnv, type ProxyConfig } from './proxy.js';

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | undefined;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
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
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k.toLowerCase()] = v;
            else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
          }
          resolve({
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

/** Single fetch with a hard timeout and no redirect surprises for paid calls. */
export async function request(req: HttpRequest): Promise<HttpResponse> {
  const url = new URL(req.url);
  const proxy = proxyFromEnv();
  let viaProxy = false;
  // Only HTTPS goes through the tunnel: CONNECT is how a proxy carries TLS, and
  // everything this CLI talks to is HTTPS except a loopback OWS, which bypasses.
  if (
    proxy &&
    url.protocol === 'https:' &&
    !bypassesProxy(url.hostname, Number(url.port || 443), proxy.noProxy)
  ) {
    viaProxy = true;
    return requestViaProxy(req, proxy);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return {
      status: res.status,
      headers,
      body: text,
      bytes: Buffer.byteLength(text),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const e = err as Error & { name?: string; cause?: { code?: string } };
    if (e.name === 'AbortError') {
      throw new X402Error(ExitCode.GENERIC, `request timed out after ${req.timeoutMs}ms`, {
        url: req.url,
        timeoutMs: req.timeoutMs,
        transient: true,
      });
    }
    throw new X402Error(ExitCode.GENERIC, `network error: ${e.message}.${proxyHint(viaProxy)}`, {
      url: req.url,
      cause: e.cause?.code,
      transient: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function parseJsonBody(body: string): unknown {
  if (body.trim() === '') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function isJsonResponse(headers: Record<string, string>): boolean {
  const ct = headers['content-type'] ?? '';
  return ct.includes('json');
}
