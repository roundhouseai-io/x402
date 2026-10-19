import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, mergeDeep, readRawConfig, type X402Config } from '../src/core/config.js';
import { authHeaders, isRoundhouseUrl, redactConfig, REDACTED } from '../src/core/auth.js';
import { discoverMarket } from '../src/core/discover.js';
import { main } from '../src/cli.js';
import { ExitCode } from '../src/core/errors.js';
import { paths } from '../src/core/paths.js';

const KEY = 'rh_live_0123456789abcdef';
const withKey = (key: string | undefined): X402Config =>
  mergeDeep(DEFAULT_CONFIG, key ? { auth: { apiKey: key } } : {});

describe('where the key may be sent', () => {
  it('accepts the apex and its subdomains, over https only', () => {
    expect(isRoundhouseUrl('https://api.roundhouseai.io/v0/flows')).toBe(true);
    expect(isRoundhouseUrl('https://roundhouseai.io/skill.md')).toBe(true);
    expect(isRoundhouseUrl('https://x402.roundhouseai.io/supported')).toBe(true);
    expect(isRoundhouseUrl('http://api.roundhouseai.io/v0/flows')).toBe(false);
  });

  it('refuses look-alikes', () => {
    expect(isRoundhouseUrl('https://evilroundhouseai.io/')).toBe(false);
    expect(isRoundhouseUrl('https://roundhouseai.io.evil.example/')).toBe(false);
    expect(isRoundhouseUrl('https://api.roundhouseai.io@evil.example/')).toBe(false);
    expect(isRoundhouseUrl('not a url')).toBe(false);
    expect(isRoundhouseUrl('https://api.example.com/v1/thing')).toBe(false);
  });
});

describe('the Authorization header', () => {
  it('is a bearer token on a Roundhouse URL', () => {
    expect(authHeaders('https://api.roundhouseai.io/v0/flows', withKey(KEY))).toEqual({
      authorization: `Bearer ${KEY}`,
    });
  });

  it('is absent for any other host, so the key is never handed to a stranger', () => {
    expect(authHeaders('https://api.example.com/v1/thing', withKey(KEY))).toEqual({});
  });

  it('is absent when no key is set', () => {
    expect(authHeaders('https://api.roundhouseai.io/v0/flows', withKey(undefined))).toEqual({});
  });

  it('never overrides one the caller wrote', () => {
    expect(
      authHeaders('https://api.roundhouseai.io/v0/flows', withKey(KEY), { Authorization: 'x' }),
    ).toEqual({});
  });
});

describe('redaction', () => {
  it('replaces a set key and leaves everything else', () => {
    const redacted = redactConfig(withKey(KEY));
    expect(redacted.auth.apiKey).toBe(REDACTED);
    expect(redacted.limits).toEqual(withKey(KEY).limits);
    expect(redactConfig(withKey(undefined)).auth).toEqual({});
  });
});

describe('discover sends the key to Roundhouse and nowhere else', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  interface SeenHeaders {
    headers: Record<string, string>[];
  }

  function stubIndex(): SeenHeaders {
    const seen: SeenHeaders = { headers: [] };
    vi.stubGlobal('fetch', async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen.headers.push(init?.headers ?? {});
      return new Response(JSON.stringify({ offers: [] }), { status: 200 });
    });
    return seen;
  }

  it('adds the bearer on the default index', async () => {
    const seen = stubIndex();
    await discoverMarket('web-search', withKey(KEY));
    expect(seen.headers[0]?.authorization).toBe(`Bearer ${KEY}`);
  });

  it('leaves it off a custom index on another host', async () => {
    const seen = stubIndex();
    const custom = mergeDeep(withKey(KEY), {
      discover: {
        unifiedUrl: 'https://index.example.com/unified',
        indexUrl: 'https://index.example.com',
      },
    });
    await discoverMarket('web-search', custom);
    expect(seen.headers[0]?.authorization).toBeUndefined();
  });
});

describe('config set auth.apiKey', () => {
  let home: string;
  const wasTty = process.stdout.isTTY;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'x402-auth-'));
    process.env.X402_HOME = home;
    process.stdout.isTTY = false;
  });
  afterEach(() => {
    delete process.env.X402_HOME;
    delete process.env.ROUNDHOUSE_API_KEY;
    process.stdout.isTTY = wasTty;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    return main(argv).then((code) => {
      vi.restoreAllMocks();
      return { code, out: out.join(''), err: err.join('') };
    });
  }

  it('stores an env reference as a reference and shows it', async () => {
    const r = await run(['config', 'set', 'auth.apiKey', 'env:ROUNDHOUSE_API_KEY']);
    expect(r.code).toBe(ExitCode.OK);
    expect(readRawConfig()).toMatchObject({ auth: { apiKey: 'env:ROUNDHOUSE_API_KEY' } });
    expect(r.out).toContain('env:ROUNDHOUSE_API_KEY');
  });

  it('never echoes a literal key back, and warns that argv is not private', async () => {
    const r = await run(['config', 'set', 'auth.apiKey', KEY]);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.out).not.toContain(KEY);
    expect(r.out).toContain(REDACTED);
    expect(r.err).toContain('command line');
    // It is stored, in the 0600 file.
    expect(readFileSync(paths.config(), 'utf8')).toContain(KEY);
  });

  it('shows neither a literal nor a resolved reference in get or list', async () => {
    await run(['config', 'set', 'auth.apiKey', KEY]);
    const got = await run(['config', 'get', 'auth.apiKey']);
    const listed = await run(['config', 'list']);
    expect(got.out).not.toContain(KEY);
    expect(listed.out).not.toContain(KEY);
    expect(got.out).toContain(REDACTED);

    await run(['config', 'set', 'auth.apiKey', 'env:ROUNDHOUSE_API_KEY']);
    process.env.ROUNDHOUSE_API_KEY = KEY;
    const resolved = await run(['config', 'get', 'auth.apiKey']);
    const resolvedList = await run(['config', 'list']);
    expect(resolved.out).not.toContain(KEY);
    expect(resolvedList.out).not.toContain(KEY);
  });

  it('is a known key, so a typo is still refused', async () => {
    expect((await run(['config', 'set', 'auth.apikey', 'x'])).code).toBe(ExitCode.GENERIC);
  });
});
