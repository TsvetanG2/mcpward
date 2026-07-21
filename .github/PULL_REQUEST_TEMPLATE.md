## What and why

<!-- What does this change, and what problem does it solve? Link any issue. -->

## Type of change

- [ ] Bug fix
- [ ] New check / heuristic
- [ ] Feature
- [ ] Docs
- [ ] Refactor / chore

## Testing checklist

<!-- These are non-negotiable for this project — see CONTRIBUTING.md -->

- [ ] Added or updated **fixtures** encoding the ground truth for this change
- [ ] **Negative test**: a known-bad fixture makes this check **fail** with the right `id` and `severity` (a check that cannot go red is a bug)
- [ ] **No false positives**: `good-server` is still 100% clean
- [ ] Pure logic (classifier / matchers / config) covered as explicit cases
- [ ] `pnpm run lint`, `pnpm run typecheck`, and `pnpm run test` pass locally

## Public contract

- [ ] This does **not** change the JSON / JUnit / SARIF report shape or exit codes
- [ ] …or it does, and golden snapshots + `CHANGELOG.md` are updated and the semver impact is noted

## Scope

- [ ] This keeps mcpward headless, deterministic, black-box and CI-shaped (no GUI, no hosted service)
- [ ] No new runtime dependency — or it was discussed and justified in the issue

## Docs

- [ ] `README.md` updated if user-facing behavior changed
- [ ] `CHANGELOG.md` updated under `Unreleased`
