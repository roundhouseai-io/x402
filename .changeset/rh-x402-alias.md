---
'@roundhouseai/x402': minor
---

Install as `rh-x402`, and correct four things the docs got wrong.

- **The binary is now `rh-x402`.** The unscoped `x402` package on npm is a different project that ships its own `x402` binary, so on a machine with both the short name was a coin toss. `rh-x402` is unique to this package. (This shipped first as an alias alongside `x402`; the `x402` bin is dropped in the same release — see below.)
- **README and SKILL.md now lead with `discover`**, which needs no wallet, key or config: `discover.indexUrl` and `discover.unifiedUrl` ship pointing at the Roundhouse index, so it reads the live Unified Services layer immediately and gives you the market — min, median, spot, spread — before anything is spent.

Four corrections, each found by driving the published package against production rather than reading the source, and each one that could have cost money as a wrong instruction:

- **The README recommended the double-payment path.** Its exit-50 row said "investigate before retrying with `--no-cache`", directly contradicting `SKILL.md`'s "never add `--no-cache` here". After a 50 the correct move is re-running the _identical_ command so the cached authorization is reused; `--no-cache` there pays twice. Fixed, and the `--no-cache` example is now labelled as the deliberate re-pay path.
- **Exit 47 means two different things** and the docs only described one. A backend that is unreachable is retryable; a backend that is _incapable_ — `cannot report balances`, `needs the optional peer dependency ethers` — never is. `docs/exit-codes.md` said to "treat the wallet layer as down", which is wrong for half the cases.
- **`wallet balance` is not universal.** It is a per-backend capability; `local` does not have it and exits 47, which reads like an outage. An unavailable balance is not a zero balance — the engine skips the pre-flight check rather than guessing, so where a backend cannot answer, read the token contract directly.
- **The `local` backend needs `ethers`** (an optional peer dependency, so a default install carries no signing code at all) and refuses a group- or world-readable keystore or a world-readable key file. Neither was in the README.

Also guards the release workflow against the mis-tag that shipped v0.1.0: it now fails loudly if the tag for the version being published already exists at a different commit, rather than publishing against a tag that describes different code.
