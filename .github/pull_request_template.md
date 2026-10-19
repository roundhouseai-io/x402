## What and why

<!-- One paragraph: what changes, and what problem it solves. Link the issue. -->

Closes #

## Payment path

<!-- Delete the ones that do not apply. Be honest; this is the part reviewers care about. -->

- [ ] Touches the payment path (402 parsing, gates, signing, the authorization cache, `X-PAYMENT`)
- [ ] Adds or changes an exit code
- [ ] Changes the JSON envelope or any machine-readable output
- [ ] Changes default behaviour (spend limits, telemetry level, redaction, file permissions)
- [ ] Adds a runtime dependency
- [ ] None of the above

If any box above is ticked, say here what an agent that depends on today's behaviour would see change:

## Testing

<!-- What you ran, and what proves the change works. For anything on the payment path, include the
     test that proves money does NOT move on the failure path. -->

```
npm run typecheck && npm run lint:slop && npm run test:coverage && npm run format:check && npm run check
```

## Security and hygiene

- [ ] No secrets, keys or tokens added — fixtures are obviously fake and, if gitleaks flags them, allowlisted by exact value in `.gitleaks.toml`
- [ ] No personal absolute paths (`/Users/<name>`, `/home/<name>`), no internal or staging URLs
- [ ] No invisible or bidi-control characters (`npm run check:unicode`)
- [ ] `npm run lint:slop` is at zero, with no new override, `warn` or boilerplate `SAFETY:` comment; tests use injected fakes or a stubbed `fetch`, not `vi.mock`
- [ ] Tests are hermetic: `fetch` stubbed, `X402_HOME` a temp dir, no real wallet, key or network call
- [ ] Workflow changes keep actions pinned, permissions minimal and `NPM_TOKEN` away from fork PRs

## Docs and changeset

- [ ] `README.md` updated (user-visible behaviour)
- [ ] `SKILL.md` updated (anything an agent sees)
- [ ] `docs/` updated (`exit-codes.md`, `spec-deviations.md`, … as applicable)
- [ ] Changeset added (`npx changeset`), or the PR is docs/CI/test-only and labelled `release: skip`
