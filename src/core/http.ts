import { X402Error, ExitCode } from './errors.js';

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

/** Single fetch with a hard timeout and no redirect surprises for paid calls. */
export async function request(req: HttpRequest): Promise<HttpResponse> {
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
    throw new X402Error(ExitCode.GENERIC, `network error: ${e.message}`, {
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
