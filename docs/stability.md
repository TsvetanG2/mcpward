# Stability policy

mcpward is used as a CI gate, so what it outputs is a contract: pipelines parse the JSON
report, code scanning ingests the SARIF, and lockfiles live in your repository for months.
This document says what is covered by that contract and how it changes.

From **1.0.0**, mcpward follows [Semantic Versioning](https://semver.org): anything listed
under *Public contract* changes incompatibly only in a new **major** version. Before 1.0.0,
incompatible changes may happen in minor versions, and every one is called out in
[`CHANGELOG.md`](../CHANGELOG.md).

## Public contract

| Surface | Contract | Machine-readable definition |
|---|---|---|
| Exit codes | `0` all checks passed · `1` at least one check failed · `2` nothing (or not everything) was tested: config error, connection error, or `timeouts.run_ms` exceeded | — |
| CLI | Commands `init`, `run`, `baseline`, `diff` and their documented flags | `mcpward --help` |
| Config | Keys, types, defaults and meaning of `mcpward.yaml` | [`schemas/config.v1.schema.json`](../schemas/config.v1.schema.json) |
| JSON report | Shape of `run --reporter json` / `diff --json`, versioned by `schemaVersion` | [`schemas/report.v1.schema.json`](../schemas/report.v1.schema.json) |
| Baseline lockfile | Shape of the file written by `baseline`, versioned by `meta.schemaVersion` | [`schemas/lockfile.v2.schema.json`](../schemas/lockfile.v2.schema.json) |
| Rule ids | Every id in [`docs/rules.md`](rules.md) (e.g. `drift/description_changed`) keeps its meaning; an id is never reused for something else | — |
| Drift classes and severities | The class names and their default severity (blast radius) | [`docs/rules.md`](rules.md#drift-rules) |
| SARIF | Valid SARIF 2.1.0; `ruleId` is the rule id with `/` replaced by `-`; `helpUri` points into `docs/rules.md`; alerts are anchored to the config file used (`artifactLocation.uri`, repo-relative) | — |
| JUnit | One `<testsuite>` per check family, one `<testcase>` per result with `classname` = rule id | — |
| GitHub Action | Inputs and outputs (`exit-code`, `report-path`) of `action.yml` (also served at the legacy path `action/action.yml`); from 1.0.0 the major tag (`@v1`) moves only to compatible releases | [`action.yml`](../action.yml) |

## Not part of the contract

- **Human-readable text**: console output, Markdown/PR-comment layout and wording, and the
  `message` field of results. Match on rule ids and statuses, never on message text.
- **Order** of results within a report. Sort by `id`/`location` if you need a stable order.
- **Which findings a server produces.** Checks get better: a minor version may detect
  something an earlier version missed (a new rule, a deeper schema comparison). That is a
  fix, not a contract change — but it can turn a passing CI run red. **Pin the mcpward
  version** (`npx mcpward@X.Y.Z`, the action's `version` input) and upgrade deliberately.
- Internal TypeScript APIs. mcpward is a CLI; importing its modules is unsupported.

## What counts as a breaking change

Requires a new major version (after 1.0.0) and a new schema file version:

- removing or renaming a report, config or lockfile field, or changing its type
- removing a rule id, drift class or check family, or changing what it means
- changing the meaning of an exit code
- a lockfile that the new version can no longer read
- removing a CLI command, flag or Action input/output

Additive — allowed in a minor version, no schema version change:

- a new optional field in the report or lockfile (the schemas allow unknown properties)
- a new rule id, check family or drift class
- a new config key whose default keeps the previous behavior
- a new CLI flag or Action input with a backward-compatible default

## Deprecation

Anything in the public contract is first **deprecated**: it keeps working, emits a warning
where possible, and is listed under *Deprecated* in the changelog for at least one minor
release. It is removed only in the next major version.

## Lockfiles

- A newer mcpward always reads lockfiles written by an older one (including v1 lockfiles,
  which are migrated in memory with a warning).
- Hashes depend on the canonicalization rules recorded in `meta.canonicalVersion`. When the
  rules change, `diff` warns that the comparison crosses a rules change; re-run
  `mcpward baseline` once to refresh the lockfile.
