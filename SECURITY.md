# Security policy

This tool authorises payments. A bug here can cost real money, so please report privately first.

## Reporting a vulnerability

**Do not open a public issue.**

Use [GitHub's private vulnerability reporting](https://github.com/roundhouseai-io/x402/security/advisories/new) for this repository, or email **security@roundhouse.ai** with:

- what you found and what an attacker (or a confused agent) can do with it;
- the version (`x402 --version`) and platform;
- a reproduction — a mock provider or a testnet transcript is ideal;
- whether you believe it has been exploited.

We aim to acknowledge within two working days, agree an assessment and timeline within a week, and credit you in the advisory unless you would rather we did not. Please give us a reasonable window to ship a fix before publishing.

## In scope, and treated as high severity

- **Double payment** — any path where one logical call can settle two authorizations, or where the authorization cache can be bypassed or poisoned.
- **Spend-gate bypass** — anything that pays past `--max`, `--budget`, `limits.dailyCap`, or an allowlist.
- **Key or credential exposure** — a private key, an OWS API key, a caller token or a sink token appearing in argv, an environment dump, a log line, the ledger, or telemetry sent to a sink.
- **Authorization reuse or replay** — an authorization usable for a different recipient, amount, asset or request than the one it was signed for.
- **`serve` authentication or authorisation flaws** — unauthenticated spend, token forgery, a token escaping its capability list or budget, or one caller reading another's ledger records without `--admin`.
- **Redaction failures** — an always-redacted header, or a configured `redactKeys` path, appearing in the ledger or a sink payload.
- **Permission regressions** — anything under `~/.x402` created world- or group-readable.

## Out of scope

- Vulnerabilities in the OWS implementation you point the CLI at, in a provider's API, or in a facilitator. Report those to their owners.
- Consequences of `--unsafe-private-key-file`, which warns on every use and is documented as development-only.
- Consequences of running `x402 serve` on a public interface, which requires an explicit acknowledgement flag.
- Losses from a wallet policy that permits more than you intended. Mirror your caps as OWS policies; the CLI-side checks are conveniences.
- Missing hardening with no exploit path (version disclosure, verbose errors on a local port, and so on). Still worth an issue, just not an advisory.

## Supported versions

Pre-1.0, only the latest published version is supported. Fixes ship as a new release; we do not backport to earlier `0.x` lines.

## Our side of the deal

- Advisories are published through GitHub Security Advisories with a CVE where one is warranted.
- Packages are published from CI, never from a laptop, and every release runs the full test suite first. They currently carry **no** [npm provenance](https://docs.npmjs.com/generating-provenance-statements): npm only attests builds from a public source repository and this one is private, so `npm audit signatures` has nothing to check. [`docs/releasing.md`](docs/releasing.md) records what that costs and how to restore it.
- We do not unpublish. A bad version is deprecated with a message pointing at the fix, so lockfiles keep resolving while telling you what happened.
