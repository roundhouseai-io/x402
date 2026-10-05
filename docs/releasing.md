# Releasing

Releases are automated: **Changesets** decides the version and the changelog, **GitHub Actions** publishes to npm, and **GitHub Releases** is the human-facing record. Nobody publishes from a laptop, and nobody edits `version` in `package.json` by hand.

## The flow

Merging to `main` publishes. There is no intermediate approval step.

```
PR with a changeset  →  merge to main  →  npm publish + version commit + tag + GitHub Release
```

1. **Every user-visible PR carries a changeset.** Run `npx changeset`, pick the bump, write one line in the voice of a changelog entry:

   ```
   npx changeset
   # patch/minor/major?  →  minor
   # summary            →  add --budget for a process-lifetime spend cap
   git add .changeset && git commit -m "Add changeset"
   ```

   Docs-only, CI-only and test-only PRs do not need one. The `release: skip` label records that choice deliberately.

2. **Merging to `main`** runs `.github/workflows/release.yml`, which:
   - counts the pending changesets and stops immediately if there are none — most merges do nothing;
   - runs `typecheck`, `test` and `build`, so nothing unbuildable or failing ever ships;
   - runs `changeset version` to apply the bumps and rewrite `CHANGELOG.md`;
   - commits that as `chore: release vX.Y.Z` and pushes it to `main`;
   - runs `changeset publish` to push the tarball to npm, and the tag;
   - creates the GitHub Release, flagged as a pre-release below 1.0.

That is the whole process. The version number is a consequence of the changesets, not a decision made at release time.

**The order is deliberate.** The version commit is pushed _before_ publishing. If the publish then fails, `main` carries a version commit with no npm release, which a re-run repairs. The reverse — published to npm, unrecorded in git — cannot be repaired, because a version can never be republished.

**Recovery is a plain re-run.** Only the two steps that mutate the repository — the version bump and its commit — are gated on there being pending changesets. Verification, publish, tag and Release always run, because after a failed publish the changesets have already been consumed, and gating those on the count would leave the recovery path doing nothing. `changeset publish` asks npm what exists and publishes only what is missing, so a re-run is safe whether or not anything is outstanding, and a job that succeeds means the version is on npm either way.

**The release commit does not loop.** Pushing `chore: release vX.Y.Z` to `main` retriggers the workflow, but a `startsWith` check on the commit message skips the whole job. Even without it the run would be harmless — no changesets to consume, and a publish that finds the version already on npm — but skipping is cheaper and clearer in the run list.

### What this trades away

The two-step flow — where the bot opens a **Version Packages** PR and a human merges it — gave a human a look at the computed version and changelog before anything reached npm. Single-step gives that up: **the reviewer of the feature PR is the last human in the loop**, and the changeset in that PR is what decides the version. Review changesets as carefully as code. If a wrong bump does reach npm, the fix is a new version, never a republish.

## Versioning

Semver, with the exit-code table and the JSON envelope treated as public API:

- **major** — renumbering or repurposing an exit code, removing or renaming an envelope field, removing a flag or command, raising the minimum Node version.
- **minor** — a new command, flag, exit code, config key or route; a new chain or asset.
- **patch** — bug fixes, 402 parser compatibility shims, docs shipped in the package, internal refactors.

Before 1.0 the same rules apply, but breaking changes go in a minor. `0.x` means the surface is still moving; `1.0` is the promise that it is not.

## What CI needs

| Secret         | Used for                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN`    | An npm **automation** token for the `@roundhouseai` scope, stored as a repository secret                                                              |
| `GITHUB_TOKEN` | Provided automatically; the workflow needs only `contents: write`. Used for the version commit, the tag and the Release — not by `changeset version`. |

Single-step publishing also needs **`main`'s branch protection to let this workflow push**. The job commits `chore: release vX.Y.Z` straight to `main`, which a ruleset that requires pull requests will reject with `protected branch hook declined`. Add a bypass for the `github-actions[bot]` actor (or for the repository ruleset's "Deploy keys and Apps" allowance) — that exemption is the price of removing the Version Packages PR, and it is the one path allowed to write to `main` without review.

## The changelog generator

`.changeset/config.json` uses the built-in `@changesets/cli/changelog`, which reads the changesets and local git history and contacts nothing. That is deliberate: `changeset version` is the step that decides what gets published, and it should not be able to fail because an API was unreachable or a token was scoped a little differently.

The alternative, `@changesets/changelog-github`, credits each entry to its pull request and author — nicer to read, but it resolves every commit through the GitHub GraphQL API, so the version step then needs a token _and_ `pull-requests: read`, and it fails closed without them. It cost two failed release runs before being removed. Entries now read `- 6816490: summary` instead of linking the PR and author; the pull request is still one `git log` away from the commit.

## Provenance is off, and why

The package ships **without** [npm provenance](https://docs.npmjs.com/generating-provenance-statements). That is a downgrade, recorded here rather than left to be discovered.

The intent was the opposite: for a package that can spend money, "where did this build come from" should be answerable by anyone, so it was switched on in three places — `publishConfig.provenance`, `provenance=true` in `.npmrc`, and `id-token: write` on the release job. The first real release run was rejected by the registry:

```
npm error 422 — Error verifying sigstore provenance bundle:
Unsupported GitHub Actions source repository visibility: "private".
Only public source repositories are supported when publishing with provenance.
```

npm will only attest builds from a public source repository, and this repository is private. Provenance and privacy cannot both hold, so provenance was dropped to get the release out.

**What that costs.** Nothing links the published tarball to a commit, a workflow or this repository, and `npm audit signatures` has nothing to verify. A consumer takes the registry's word that the tarball is what the maintainers uploaded.

**How to get it back.** Make the repository public, then restore `publishConfig.provenance: true`, `provenance=true` in `.npmrc`, and `id-token: write` on the release job. All three — `.npmrc` alone is enough to turn it on, so a partial removal fails confusingly, with npm asking for an `id-token` permission the workflow has deliberately dropped. Nothing else has to change — the failed run proved every other part of the publish path works. Worth doing: the repository is Apache-2.0 and written throughout as an open-source project, so privacy is the thing out of place here, not the attestation.

## Checking a release

```bash
npm view @roundhouseai/x402 version
npm view @roundhouseai/x402 dist.tarball
npx @roundhouseai/x402@latest --version
```

There is no provenance badge on the npm page and nothing for `npm audit signatures` to check — see above.

To see what would ship before publishing:

```bash
npm run build
npm pack --dry-run     # should contain dist/, README.md, SKILL.md, LICENSE — nothing else
```

## Manual publish (break-glass)

Only if CI is broken and a release cannot wait. CI publishes unattested too at the moment, so the difference is only that nobody reviewed the build — say so in the release notes and follow up with a normal release.

```bash
npm run typecheck && npm test && npm run build
npm publish --access public
```

Then create the GitHub Release by hand from the tag, with the changelog section as the body.

## Yanking

Do not unpublish. Deprecate and supersede:

```bash
npm deprecate @roundhouseai/x402@0.1.3 "double-payment bug; upgrade to 0.1.4"
```

Then release the fix, and note it in the affected GitHub Release. If the bug can cost users money, follow `SECURITY.md` and issue an advisory as well.
