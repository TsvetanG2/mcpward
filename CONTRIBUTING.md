# Contributing to mcpward

Thanks for considering a contribution. This document covers the rules that are specific to this project — especially the testing philosophy, which is stricter than most repos and is non-negotiable.

## Prime directive

`mcpward` is **not** an MCP inspector. Interactive/manual debugging is well covered by [`modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector) and [MCPJam](https://github.com/MCPJam/inspector); in-process unit testing of servers you author is covered by `fastmcp`. `mcpward` stays **headless, deterministic, black-box, and CI-shaped**.

Contributions that add a GUI, a hosted service, or interactive exploration will be declined regardless of quality. Contributions that sharpen black-box detection — drift, rug-pulls, tool poisoning, error-contract correctness — are exactly what we want.

## Development setup

```bash
git clone https://github.com/TsvetanG2/mcpward.git
cd mcpward
pnpm install
pnpm run build
pnpm run test
pnpm run lint
pnpm run typecheck
```

Requires **Node ≥ 20** and **pnpm**.

## The testing rules (read this before writing a check)

A test harness nobody can trust is worse than no harness. A green suite proves nothing unless you have proven it can go **red** for the right reason.

### 1. Fixtures are ground truth

We do not validate checks against real third-party servers, because we do not control their correctness. Every check is developed against **controlled fixture servers** in `fixtures/`, built with the official MCP SDK, whose correct/incorrect status we define:

| Fixture | Ground truth |
| --- | --- |
| `good-server` | Fully compliant, correct two-layer errors, fast, clean descriptions |
| `malformed-server` | Schema violations: empty/missing descriptions, invalid names, duplicate names, bad inputSchema |
| `error-contract-server` | For testing two-layer error contract validation |
| `hanging-server` | Never responds to tool calls (timeout testing) |
| `drift/v1` → `drift/v2` | Exactly one change per classification class |
| `slow-server` | Deliberately over the latency budget |
| `poisoned-server` | Injection text, hidden unicode, secret-soliciting schema |

### 2. Write the fixture before the check

The check must be developed against known-bad input, not the other way around. Otherwise you are fitting the test to the implementation.

### 3. Every check needs a negative test — mandatory

For every check you add, write a test that feeds a known-bad fixture and asserts the harness returns a **failure** with the right `id` and `severity`. **A check that cannot go red is a bug, not a feature.** PRs adding a check without a negative test will be asked for changes.

### 4. False positives are release blockers

`good-server` must stay 100% clean. A security or drift check that cries wolf is worse than an absent one — it trains users to ignore output. If your heuristic trips on `good-server`, it is not ready.

### 5. Pure logic gets truth-table tests

The drift classifier, schema wrappers, JSONPath assertions, config parser, and exit-code logic are pure and deterministic. Cover every branch as an explicit case. We do not chase a global coverage percentage; we care about the classifier, the error-layer logic, and the security matchers specifically.

### 6. Report shapes are a public contract

The JSON, JUnit, and SARIF output shapes and the exit codes (`0`/`1`/`2`) are consumed by other people's CI. They are golden-snapshotted. Changing them is a deliberate, documented, semver-relevant decision — never an accident.

## Architecture rules

- **Always** talk to servers through the official `@modelcontextprotocol/sdk` client. Never hand-roll the protocol; testing against a reimplementation invalidates the results.
- **Never hardcode a protocol version.** Read what the SDK negotiates and treat it as data.
- Keep all protocol assumptions inside `src/client/`.
- Every check emits the same normalized result object (`{id, family, status, severity, message, expected, actual, location}`). Reporters only read that model — never special-case a check inside a reporter.
- Treat all server output as hostile input. Never `eval`, never interpolate a server-supplied string into a shell command or a file path.
- Ask before adding a runtime dependency. Low dependency count is a feature for a security tool.

## Adding a security heuristic

1. Add the malicious pattern to `fixtures/poisoned-server`.
2. Write the negative test asserting it trips.
3. Implement the matcher.
4. Verify `good-server` stays clean.
5. Ensure the finding maps to a sensible SARIF rule with a `location`.

## Commit and PR conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`. Breaking changes get `!` or a `BREAKING CHANGE:` footer.
- One logical change per PR.
- CI (lint, typecheck, unit + fixture + negative + golden tests, Node 20/22 × Linux/macOS) must be green before merge.
- Do not commit red or broken states.
- Update `README.md` when you change user-facing behavior, and `CHANGELOG.md` under `Unreleased`.

## Reporting bugs

Use the issue templates. For **security** problems — especially a false negative where `mcpward` reports a genuinely poisoned or drifted server as clean — follow [`SECURITY.md`](SECURITY.md) and report privately instead.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
