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
npm run typecheck && npm test && npm run format:check
```

## Docs and changeset

- [ ] `README.md` updated (user-visible behaviour)
- [ ] `SKILL.md` updated (anything an agent sees)
- [ ] `docs/` updated (`exit-codes.md`, `spec-deviations.md`, … as applicable)
- [ ] Changeset added (`npx changeset`), or the PR is docs/CI/test-only and labelled `release: skip`
