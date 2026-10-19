import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { request as httpRequest, type ClientRequestArgs } from 'node:http';
// Extends the *https* Agent: `https.request` checks `agent.protocol`, and an
// `http.Agent` is rejected with "Protocol https: not supported". The base
// class's own TLS handling is irrelevant here — `createConnection` is fully
// overridden and hands back a socket that is already tunnelled and secured.
import { Agent, type AgentOptions } from 'node:https';
import type { Duplex } from 'node:stream';
import { Socket } from 'node:net';
import type { HeaderMap } from './http.js';

/**
 * `HTTPS_PROXY` support, without a dependency.
 *
 * Node's global `fetch` ignores the proxy environment variables. `--use-env-proxy`
 * turns that on but landed in Node 22, and this package supports Node 20 — so on
 * a proxied machine every request fails with a bare 403 or a connection error
 * that names nothing, and the obvious readings (endpoint down, wrong URL,
 * service rejected us) are all wrong.
 *
 * So: an `http.Agent` that opens a CONNECT tunnel and runs TLS inside it, which
 * is what a proxy expects for HTTPS. It is used through `node:https`, not
 * `fetch`, because `fetch` gives no way to attach an agent.
 */

export interface ProxyConfig {
  url: string;
  /** Host:port pairs and suffixes that must bypass the proxy. */
  noProxy: string[];
}

/** Read the usual environment variables. Lowercase wins, as curl does it. */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): ProxyConfig | undefined {
  const url = env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY;
  if (!url) return undefined;
  const raw = env.no_proxy ?? env.NO_PROXY ?? '';
  const noProxy = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return { url, noProxy };
}

/**
 * Whether `host` is exempt.
 *
 * `NO_PROXY=*` disables proxying entirely; an entry may be a bare host, a
 * `.suffix`, or a `host:port`. Loopback is never proxied — a proxy that has to
 * be asked for `127.0.0.1` is a misconfiguration, and in this CLI that address
 * is the OWS backend.
 */
export function bypassesProxy(host: string, port: number, noProxy: string[]): boolean {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1') return true;
  if (noProxy.includes('*')) return true;
  return noProxy.some((entry) => {
    const [entryHost, entryPort] = entry.split(':');
    if (entryPort && Number(entryPort) !== port) return false;
    const target = (entryHost ?? '').replace(/^\./, '');
    return lower === target || lower.endsWith(`.${target}`);
  });
}

/** `Proxy-Authorization` from credentials in the proxy URL, when present. */
function proxyAuthHeader(proxy: URL): HeaderMap {
  if (!proxy.username) return {};
  const raw = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { 'proxy-authorization': `Basic ${Buffer.from(raw).toString('base64')}` };
}

/**
 * An agent that reaches an HTTPS origin through a CONNECT tunnel.
 *
 * `createConnection` is the whole trick: the agent hands back a TLS socket that
 * is already tunnelled, so everything above it behaves as if the origin were
 * reachable directly.
 */
export class ProxyTunnelAgent extends Agent {
  private readonly proxy: URL;

  constructor(proxyUrl: string, options: AgentOptions = {}) {
    super(options);
    this.proxy = new URL(proxyUrl);
  }

  override createConnection(
    options: ClientRequestArgs & { servername?: string },
    callback?: (err: Error | null, stream: Duplex) => void,
  ): undefined {
    // Node calls this with a callback for every request it makes; the optional
    // signature is the base class being permissive, not a real case.
    const done = callback ?? (() => undefined);
    const host = options.host ?? '';
    const port = Number(options.port ?? 443);
    const proxyPort = Number(this.proxy.port || (this.proxy.protocol === 'https:' ? 443 : 80));

    const req = httpRequest({
      host: this.proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, ...proxyAuthHeader(this.proxy) },
      // The tunnel is the point; do not let Node reuse a pooled socket for it.
      agent: false,
    });

    req.once('connect', (res, socket: Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        // A proxy refusing CONNECT is a policy answer, not a transport failure,
        // so say which it was rather than reporting a socket error.
        done(
          new Error(
            `proxy ${this.proxy.origin} refused CONNECT to ${host}:${port} ` +
              `with ${res.statusCode} ${res.statusMessage ?? ''}`.trim(),
          ),
          socket,
        );
        return;
      }
      const tls: TLSSocket = tlsConnect({ socket, servername: options.servername ?? host });
      tls.once('error', (err) => done(err, tls));
      tls.once('secureConnect', () => done(null, tls));
    });
    // On an error Node reads only `err`; a request that never got a socket
    // hands over an unconnected one to satisfy the signature.
    req.once('error', (err) => done(err, req.socket ?? new Socket()));
    req.end();
    return undefined;
  }
}
