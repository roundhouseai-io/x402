# Deviations from the spec

Every knowing departure from [`SPEC.md`](SPEC.md), with the reason. If you change behaviour away from the spec, add a row here in the same PR — or change the spec instead.

## 1. `npx x402` is `npx @roundhouseai/x402` — resolved in the spec

**Spec (as authored):** §2 promised `npx x402 <url>`.

**Implementation:** the unscoped `x402` name on npm is already taken by another project, so `npx x402` resolves to that package, not this one. The zero-install form is `npx @roundhouseai/x402 <url>`; the binary is still called `x402`, so a global install gives the short command the spec describes.

The scope is `@roundhouseai`, matching the `roundhouseai-io` GitHub org.

**Status:** closed. §2 has been amended to `npx @roundhouseai/x402` throughout, so the spec and the implementation agree and this is no longer a deviation. Per-command examples elsewhere in the docs still use the short `x402 <subcommand>` form, which is what a global install gives you. No document should promise a bare `npx x402`.

## 2. The authorization cache key omits `validBefore`

**Spec:** §5.1 keys the cache on `hash(url + method + body + payTo + amount + validBefore)`.

**Implementation:** the key is `hash(method + url + hash(body) + payTo + amount + asset + chain + wallet)`; `validBefore` is stored _in_ the entry and used for expiry.

**Why:** `validBefore` is computed at signing time, so a key containing it can never be hit by a later retry — the retry would compute a new expiry, miss the cache, and sign again. That defeats the stated purpose of the cache (the primary defence against double payment). Keying on request identity and expiring on the stored `validBefore` gives the behaviour §5.1 describes.

**Status:** proposed spec amendment.

## 3. The domain allowlist is checked before the payTo allowlist

**Spec:** §5.4 lists the gates as payTo allowlist → `--max` → session budget → OWS policy, and §7 defines `allowlist.domains` without placing it in that order.

**Implementation:** domain → payTo → `--max` → session budget → daily cap → OWS policy.

**Why:** the domain gate is about _who you are talking to_ and can be evaluated from the request alone, so it is the cheapest possible refusal. It also produces the clearer error: "domain not in allowlist" beats a payTo mismatch for a provider you never intended to reach. Both still return exit `43`, so the contract is unchanged.

## 4. The daily cap is a distinct gate step

**Spec:** §7 defines `limits.dailyCap` as advisory and CLI-enforced from the ledger; §5.4's gate list does not name it.

**Implementation:** it is checked after the session budget and shares exit code `45` with it.

**Why:** §8 already assigns "session budget or daily cap exhausted" to `45`, so this only makes the ordering explicit.

## 5. `pay` does not use the authorization cache

**Spec:** §5.1 describes the cache in terms of the `call` flow.

**Implementation:** `rh-x402 pay` signs fresh every time.

**Why:** a bare 402 payload carries no request identity (no url, method or body), so there is nothing stable to key a cache entry on. Caching on the payload alone would risk returning an authorization for a _different_ request that happened to quote the same price. `pay` is a header-building primitive; callers that need idempotency should use `call`.

## 6. The `local` keystore refuses group-readable files too, and takes its passphrase from the environment only

**Spec:** §9.1 requires a refusal for a world-readable keystore; §5.3 says the passphrase comes "from env or prompt".

**Implementation:** the keystore refuses a group- _or_ world-readable file, and the passphrase comes from `X402_KEYSTORE_PASS` or a config `env:` indirection. There is no interactive prompt.

**Why:** a group-readable key on a shared machine is nearly as bad as a world-readable one, so the stricter check is free. The prompt is deliberately absent for now: the primary user is an agent with no terminal, a hidden-input prompt is easy to get wrong, and a half-working prompt is worse than a clear error telling you which variable to set. Worth adding when a human actually asks for it.

## 7. stdin is only consumed when it is genuinely readable

**Spec:** §4 lists stdin as a data mechanism.

**Implementation:** stdin is read when it is a pipe, socket or redirected file, or when a `-` argument explicitly asks for it. A terminal or character device (`/dev/null`, a detached tty in a hosted agent runtime) is never read.

**Why:** reading a character-device stdin can block forever, which to an agent is indistinguishable from a hung payment. `cat payload.json | rh-x402 call <url> --json -` and `rh-x402 call <url> < payload.json` both work.

## 8. `signer` is an extra command, and the keystore has one too

**Spec:** §3's command table does not list a signer command; §5.3 defines the backends but no way to inspect or populate them.

**Implementation:** `rh-x402 signer list`, `rh-x402 signer check [backend]`, `rh-x402 signer keystore list` and `rh-x402 signer keystore add <name> --key-file <path>`.

**Why:** §5.3 rule 2 requires the CLI to fail at _config_ time when a backend cannot sign typed data, which needs a command that resolves a backend and reports its capabilities — `signer check` is that command. And a `local` backend with no way to create a keystore entry is unusable. Keys are read from a file, never from argv, and the passphrase comes from the environment.

## 9. MCP transport is stdio only

**Spec:** §10 mentions "stdio or SSE".

**Implementation:** `--mcp` serves stdio.

**Why:** SSE is deprecated in the MCP transport spec in favour of streamable HTTP, and §12.5 already proposes deferring MCP to v1.1. Adding a second transport before the first is exercised is scope with no caller.
