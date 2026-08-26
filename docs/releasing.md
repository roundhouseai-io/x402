# Releasing

Releases are automated: **Changesets** decides the version and the changelog, **GitHub Actions** publishes to npm with provenance, and **GitHub Releases** is the human-facing record. Nobody publishes from a laptop, and nobody edits `version` in `package.json` by hand.

## The flow

```
PR with a changeset  →  merge to main  →  "Version Packages" PR (bot)  →  merge  →  npm publish + GitHub Release + tag
```

1. **Every user-visible PR carries a changeset.** Run `npx changeset`, pick the bump, write one line in the voice of a changelog entry:

   ```
   npx changeset
   # patch/minor/major?  →  minor
   # summary            →  add --budget for a process-lifetime spend cap
   git add .changeset && git commit -m "Add changeset"
   ```

   Docs-only, CI-only and test-only PRs do not need one. The `release: skip` label records that choice deliberately.

2. **Merging to `main`** runs `.github/workflows/release.yml`. If unreleased changesets exist it opens (or updates) a **Version Packages** PR that applies the bumps and rewrites `CHANGELOG.md`.

3. **Merging the Version Packages PR** publishes: `changeset publish` pushes the tarball to npm and the git tag, and the workflow then creates the matching GitHub Release with the changelog section as its body. Pre-1.0 tags are marked as pre-releases.

That is the whole process. The version number is a consequence of the changesets, not a decision made at release time.

## Versioning

Semver, with the exit-code table and the JSON envelope treated as public API:

- **major** — renumbering or repurposing an exit code, removing or renaming an envelope field, removing a flag or command, raising the minimum Node version.
- **minor** — a new command, flag, exit code, config key or route; a new chain or asset.
- **patch** — bug fixes, 402 parser compatibility shims, docs shipped in the package, internal refactors.

Before 1.0 the same rules apply, but breaking changes go in a minor. `0.x` means the surface is still moving; `1.0` is the promise that it is not.

## What CI needs

| Secret         | Used for                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`    | An npm **automation** token for the `@roundhouse` scope, stored as a repository secret                     |
| `GITHUB_TOKEN` | Provided automatically; the workflow needs `contents: write`, `pull-requests: write` and `id-token: write` |

`id-token: write` is what makes [npm provenance](https://docs.npmjs.com/generating-provenance-statements) work: the published package carries a signed attestation linking it to this repository, this workflow and this commit. `provenance` is set in `publishConfig`, so a publish from anywhere without an OIDC token fails rather than quietly shipping an unattested tarball. That is deliberate — for a package that can spend money, "where did this build come from" should be answerable by anyone.

## Checking a release

```bash
npm view @roundhouseai/x402 version
npm view @roundhouseai/x402 dist.tarball
npx @roundhouseai/x402@latest --version
```

The npm page shows the provenance badge; `npm audit signatures` verifies it locally.

To see what would ship before publishing:

```bash
npm run build
npm pack --dry-run     # should contain dist/, README.md, SKILL.md, LICENSE — nothing else
```

## Manual publish (break-glass)

Only if CI is broken and a release cannot wait. It produces an _unattested_ package, so say so in the release notes and follow up with a normal release.

```bash
npm run typecheck && npm test && npm run build
npm publish --access public --provenance=false
```

Then create the GitHub Release by hand from the tag, with the changelog section as the body.

## Yanking

Do not unpublish. Deprecate and supersede:

```bash
npm deprecate @roundhouseai/x402@0.1.3 "double-payment bug; upgrade to 0.1.4"
```

Then release the fix, and note it in the affected GitHub Release. If the bug can cost users money, follow `SECURITY.md` and issue an advisory as well.
