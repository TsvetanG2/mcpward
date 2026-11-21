# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Since `1.0.0`, the public contract described in [`docs/stability.md`](docs/stability.md) — exit codes, CLI, config, JSON report, lockfile, rule ids, SARIF/JUnit structure and the GitHub Action — changes incompatibly only in a major version. In `0.x`, minor versions could contain breaking changes; each one is called out below.

## [Unreleased]

### Added

- **New drift class `annotation_relaxed`** (medium, not in the default `fail_on`): a tool hint now claims a safer tool — `readOnlyHint` false→true, `destructiveHint` true→false or `openWorldHint` true→false. These changes passed silently. A tool that tells clients "I am harmless now" after you reviewed it is on the path to auto-approval, so it is reported as a warning.
- **New drift class `idempotency_changed`** (medium, non-breaking, not in the default `fail_on`): a tool's `idempotentHint` changed, in either direction. true→false means a retried call may now repeat its effects; false→true means the tool now claims retries are harmless. A retry risk, not a data risk, so it is a warning of its own instead of part of `annotation_changed`.
- **New rule id `drift/titles-not-compared`** (warning): the baseline was written before 1.3.0, so tool titles are not compared against it. Re-run `mcpward baseline` to clear it.

### Changed

- **`annotation_changed` covers `openWorldHint`.** Besides `readOnlyHint` true→false and `destructiveHint` false→true, it now reports `openWorldHint` false→true (high): the tool may now reach external systems.
- **Hints are compared as the MCP spec reads them.** An absent hint counts as its default (`readOnlyHint` false, `destructiveHint` true, `idempotentHint` false, `openWorldHint` true), so a hint that appears or disappears is classified like a flip. `destructiveHint` and `idempotentHint` are not compared while a tool is read-only on either side, since they do not apply to it.

### Fixed

- **Text the model reads in a schema passed drift silently.** `title`, `default`, `examples`, `$comment` and `x-*` extensions (and the common non-standard `example` and `enumDescriptions`) were skipped at every level, and `description` at the schema root, so an instruction planted there after the baseline was never reported. They are now `description_changed` (high) at every level, the root included: `title` and `description` compared canonically (formatting is not drift), the others as data (exactly, after Unicode NFC). The `deprecated`, `readOnly` and `writeOnly` flags are now `nonbreaking_schema_change` (low). Text inside keywords the walk does not model (`anyOf`/`oneOf`/`allOf`, `patternProperties`, `propertyNames`, `prefixItems`, `contains`, `dependentSchemas`, `dependencies`, `if`/`then`/`else`, `not`, `unevaluatedProperties`) is still reported as `breaking_schema_change`. A `title` or `description` that is not a string is compared exactly. A new `$defs`/`definitions` entry is `nonbreaking_schema_change` at medium with its description quoted, high when it brings in hostile text or a secret-soliciting field — like a new input field.
- **Hostile text in new structure was only read in descriptions.** A new optional field, a subschema that was `false` or `true`, `additionalProperties` that were closed or a new `items` schema escalate to high when they bring in injection-like phrasing or hidden unicode; that test now also reads `title`, `$comment` and every string in `default`, `examples` and `x-*` values, and covers `additionalProperties` and `items`, which it skipped.
- **Reordering a `required` list inside `const`, `enum`, `default`, `examples`, `example`, `enumDescriptions` or an `x-*` value was not drift.** Canonicalization sorted every array named `required` as if it were a schema keyword; inside data it now keeps its order.
- **Tool titles were not captured.** The tool's top-level `title` and `annotations.title`, which some clients show to the model, are now stored in the lockfile (optional fields, additive) and a change is `description_changed`.

### Upgrading

Checks get better ([`docs/stability.md`](docs/stability.md)); three effects to expect:

- **A server that adds annotations for the first time gets `annotation_relaxed` warnings** for every hint safer than its default (for example a new `readOnlyHint: true`), and `idempotency_changed` for a new `idempotentHint: true`. They do not fail CI with the default `fail_on`; with `fail_on: medium` or `low` they do.
- **A server that removes `readOnlyHint: true` or `destructiveHint: false` now produces `annotation_changed` with high severity and fails CI by default.** Removing the hint widens the tool's authority exactly like flipping it, and was missed before. The same holds for `openWorldHint: false`. Removing `idempotentHint: true` produces `idempotency_changed`, a warning that does not fail CI by default.
- **Schema text is now compared, so a passing CI run can turn red** when a schema's `title`, `default`, `examples`, `$comment`, `x-*` or root `description` changed since the baseline. These were false negatives. A value generated per release (a version stamp in `default` or an `x-*` field) now reports on every release: review it and re-baseline (lowering `description_changed` would hide real rug-pulls too).

Review each finding; if the change is intended, re-baseline. Pin the mcpward version and upgrade deliberately.

Canonicalization moves to v3 (a `required` list inside instance data keeps its order). A baseline from 1.2.x is still compared under its own v2 rules, so the change alone is never drift; `diff` prints a one-line notice until you re-baseline.

Run `mcpward baseline` again to start tracking tool titles; older baselines skip title comparison, and a `drift/titles-not-compared` warning says so. Older mcpward versions read the new lockfile fields without error.

## [1.2.1] — 2026-11-18

### Fixed

- **A secret-soliciting field behind a pointer into a nested `$id` resource was missed.** A reference such as `#/definitions/Bundle/definitions/Auth`, where `Bundle` declares its own `$id`, kept resolving the target's own references (`#/definitions/Creds`) against the document root, so `Creds.password` was never seen. References now resolve in the schema resource the pointer leads into. This affects `security/secret-in-schema` and the high-severity escalation of `input_property_added`, whose quoted description is now read from the right target too (#88).
- **Two schema changes that can reject previously valid input passed as non-breaking.** A definition used in a `contains` limited by `maxContains` is now treated like one under `not`/`if`/`oneOf`: matching more items can exceed the maximum. A definition referenced by a plain-name anchor (`$anchor`, or draft-07 `$id: "#name"`), on it or anywhere inside it, is now recognised as used there. Any change inside such a definition is `breaking_schema_change` (#90).

### Upgrading

Both fixes are false negatives: findings that were always there are now reported and **can turn a passing CI run red**. Review each one; if the change is intended, re-baseline. Pin the mcpward version (`npx mcpward@1.2.1`, the action's `version` input) and upgrade deliberately.

## [1.2.0] — 2026-11-16

### Added

- **New drift class `input_property_added`** ([discussion #83](https://github.com/TsvetanG2/mcpward/discussions/83), reported by [@heyitsjakub](https://github.com/heyitsjakub)). An existing tool that gains an optional input field, at any nesting depth, was `nonbreaking_schema_change` (low), and the new field's description was never looked at. That is the shape of a post-approval attack: a tool you already approved gains an optional `context` field ("Extra context that helps the tool answer better") and a helpful agent fills it with local file contents — the tool description does not have to change, and `fail_on: high` let it through. Compatibility and security are separate axes: the change is still non-breaking, but its default severity is now **medium**, and **high** when the new field (or anything nested in it) has a secret-soliciting name or a description with injection-like phrasing or hidden unicode. The finding quotes the new field's description. An optional field added to an `outputSchema`, a new tool and a schema that did not exist before keep their classes.

### Changed

- **`security/secret-in-schema` checks every nesting level** — nested properties, array items, `additionalProperties` and `anyOf`/`oneOf`/`allOf` branches — not only top-level field names, and reports full paths (`options.password`, `accounts[].token`).

### Upgrading

Both changes can turn a passing CI run red; pin the mcpward version (`npx mcpward@X.Y.Z`, the action's `version` input) and upgrade deliberately (see [`docs/stability.md`](docs/stability.md#not-part-of-the-contract)).

- With the **default `fail_on`** nothing changes for new optional input fields: the default list does not include `input_property_added`, as it did not include `nonbreaking_schema_change`. When it does not fail the run, an `input_property_added` result is reported as `warn` (not `pass`), so the console shows it and its description without `--verbose`.
- With **`fail_on: medium`**, a new optional input field now fails the run. With **`fail_on: high`**, a new optional field fails only when it looks hostile.
- **Config written for `nonbreaking_schema_change` keeps its meaning**: a `fail_on` list that names it also fails on `input_property_added`, and a `checks.drift.severity` override for it also applies to `input_property_added` unless that class has its own override, which wins. The workaround suggested in the discussion, `severity: { nonbreaking_schema_change: high }`, keeps working; `severity: { input_property_added: high }` does the same without promoting widened types and loosened constraints.
- A secret-soliciting field nested in a tool's input schema is now reported by `security/secret-in-schema`, which fails the run as it always did for top-level fields.
- If you match JSON or SARIF results on `drift/nonbreaking_schema_change` to find added input fields, match `drift/input_property_added` as well.

## [1.1.3] — 2026-11-15

### Fixed

- **Drift inside `$defs`/`definitions` was invisible.** Schemas generated by zod or pydantic keep every shared or recursive type in `$defs` and point to it with `$ref`; mcpward compared neither, so narrowing a type, making a field required or rewriting a parameter description inside a definition produced no drift at all. Definitions are now compared by name (paths like `$defs/Item.x`), with the same rules as inline properties, and a description changed there is `description_changed`. A definition used under `not`, `if` or `oneOf` can reject more when it accepts more, so any change inside it is breaking.
- **Drift ignored JSON Schema keywords it does not model.** A change to `prefixItems`, `contains`, `not`, `if`/`then`/`else`, `dependentRequired`, `propertyNames`, `unevaluatedProperties`, `$ref` and similar keywords produced no drift. Adding, changing or removing one is now `breaking_schema_change` ("compatibility cannot be determined", the rule `anyOf` already followed) — a removal can reject more too. A changed `$schema` dialect is reported the same way, since it can switch keywords on. Annotations and `x-` extensions are not compared. `additionalItems` tightened behind an unchanged tuple is now breaking as well.
- **`schema/tool-input-schema` failed every tool whose schema declares JSON Schema 2020-12 or 2019-09.** Schemas were compiled with Ajv's draft-07 build, which cannot load those meta-schemas ("no schema with key or ref"). The Ajv build now follows `$schema`; a schema without `$schema` is compiled as before. The same applies to `behavioral/output-schema`, which now enforces 2020-12 keywords such as `prefixItems` instead of ignoring them.
- **A lockfile written by a newer mcpward is refused instead of mangled.** Any `meta.schemaVersion` other than 2 was treated as a v1 lockfile and "migrated", discarding its provenance. An unknown version now fails `drift/baseline-invalid` with a message to upgrade mcpward.

### Upgrading

The two drift fixes are false negatives: schema changes that were always there are now reported, and **can turn a passing CI run red** (`breaking_schema_change` fails by default). Review each new finding; if the change is intended, re-baseline. As always, pin the mcpward version (`npx mcpward@1.1.3`, the action's `version` input) and upgrade deliberately.

## [1.1.2] — 2026-11-15

### Fixed

- **A stdio server no longer outlives mcpward** ([#71](https://github.com/TsvetanG2/mcpward/issues/71), reported by a community member). Two cases left a server that ignores stdin EOF and SIGTERM running after mcpward exited: a `timeouts.connect_ms` timeout did not close the transport at all, and closing stopped only the process mcpward spawned — a server started through a wrapper (`npx`, `tsx`, `uvx`, `sh -c`, `cmd /c` on Windows) is a grandchild of mcpward and kept running. A failed or timed-out handshake now closes the transport, and every close — mcpward's or the SDK's own — stops every process the server command started that is still running, including processes started while the server shuts down (SIGTERM, then SIGKILL after 2 s). A process is identified by its pid and start time, re-checked against a fresh process listing before each signal, so a pid reused by an unrelated process is not signalled (barring reuse in the few milliseconds between that check and the signal; on macOS start times have 1 s resolution). The process tree is read from `/proc` (Linux), `ps` (macOS) or `Get-CimInstance` (Windows); if it cannot be read, nothing extra is signalled and cleanup is what it was before. Known limit: on Linux and macOS, a process the server starts in the last ~250 ms before it is stopped can still escape, since the SDK's stdio transport offers no way to start the server in its own process group.

### Changed

- Dependencies: `@modelcontextprotocol/sdk` 1.30.0 → 1.32.2 (no change to the stdio transport mcpward relies on), `zod` 4.6.7, dev tooling (eslint, prettier, typescript-eslint, vitest, `@types/node`), and the CodeQL, setup-node and Scorecard actions.

## [1.1.1] — 2026-10-05

### Changed

- **License: MIT → Apache-2.0**, starting with this release. Using, modifying and redistributing mcpward — commercially too — stays allowed; redistributions and derivative works must now include the license, carry the attribution from `NOTICE` (in a NOTICE file, their documentation or a third-party-notices display) and mark modified files, and the Apache license grants no rights to the name "mcpward". Versions up to and including 1.1.0 remain available under the MIT License. No functional changes.

## [1.1.0] — 2026-10-05

**Safer tool calls.** Checks that call tools now follow one documented policy, and you can see and control exactly what they call.

### Changed

- **Latency measures only read-only tools by default.** Measuring latency calls each tool `samples` times; before 1.1.0 it called _every_ tool with generated arguments, destructive ones included. It now follows the same policy as output drift: tools annotated `readOnlyHint: true` (and not `destructiveHint: true`) are measured, plus the tools you list in `checks.latency.tools` with arguments. Tools that are not measured are listed in the new `latency/sampling` result with the reason, and when nothing can be measured `latency/summary` warns instead of passing. This changes which tools are measured — a safety fix, so it ships in a minor version; `checks.latency.call_all: true` restores the previous behavior for test instances.

### Added

- `checks.latency.tools` (allowlist with arguments), `checks.latency.call_readonly` and `checks.latency.call_all`.
- `checks.errors: false` turns off the error-contract checks, which call an unknown tool and every tool that has required parameters with empty arguments. On by default, as before.
- Rule `latency/sampling`.
- README: which checks call tools, the error-contract checks, every Action input and output, and a warning against re-baselining automatically in CI.

### Fixed

- Latency counts only completed calls. A rejected call (for example generated arguments failing validation) or an `isError: true` result was recorded as a sample, so a server that rejected every call quickly "passed" the budget. Failed calls are now excluded and reported, and a call that times out fails the latency check — even when `call_ms` is below the budget. Only mcpward's own `call_ms` timeout counts as one — a server returning error code `-32001` cannot pass off a rejection as a slow call.
- `timeouts.call_ms` above 60 seconds is honored: the SDK's own 60-second request timeout no longer ends tool calls first.
- `examples/ci.yml` no longer refreshes the baseline on every push to `main` — that would accept a rug-pull as the new contract. Examples pin `mcpward@1`, and `examples/mcpward.yaml` expects the protocol version the SDK negotiates today.
- `docs/rules.md`: severities of the error-contract and latency rules match what mcpward emits (`errors/invalid-params` is a warning; `latency/summary`, not `latency/tool`, enforces the budget).
- README comparison tables re-checked against each project's current documentation (mcp-scan is now Snyk Agent Scan).
- `SECURITY.md`: current dependency footprint; the dependency lockfile is free of known advisories.

## [1.0.0] — 2026-10-05

**mcpward 1.0.0.** No functional changes from 0.9.0 — this release makes a promise: the public contract in [`docs/stability.md`](docs/stability.md) (exit codes, CLI, config, JSON report, lockfile, rule ids, drift classes, SARIF/JUnit structure, GitHub Action inputs and outputs) now changes incompatibly only in a major version.

What 1.0 contains, by milestone:

- **Drift & rug-pull detection** — canonicalized description hashing with word-level diffs that make invisible characters visible; tool-, schema- (recursive: enums, bounds, patterns, nested properties, array items) and annotation-level drift; parameter descriptions are rug-pull vectors too; severity by blast radius with `fail_on: high|medium|low`; opt-in output-shape drift that only calls read-only or allowlisted tools.
- **Tool-poisoning heuristics** — injection phrasing, hidden and zero-width unicode, Unicode Tag "ASCII smuggling" (decoded), secret-soliciting schemas, `readOnlyHint` mismatches — at every nesting level; full `tools/list` pagination.
- **Description collision lint** — near-identical descriptions over divergent input schemas, offline, no baseline needed.
- **Protocol & contract checks** — compliance, schema validity, the two-layer error contract, behavioral suites with JSONPath and golden snapshots, latency budgets.
- **CI surface** — console, JSON, JUnit, SARIF and Markdown reporters; PR comments; a GitHub Action (`uses: TsvetanG2/mcpward@v1`); stdio and Streamable HTTP with tested parity; published JSON Schemas for report, config and lockfile.

### Changed

- The GitHub Action's major tag `v1` is created by this release and moves only to compatible 1.x releases. Docs and examples use `@v1`.
- Security fixes are provided for the latest 1.x minor ([`SECURITY.md`](SECURITY.md)).
- Documentation brought up to date: README examples reflect current output and current action versions, CONTRIBUTING lists every fixture and the schema/rule-documentation rules, published articles are linked.

## [0.9.0] — 2026-10-05

This release implements **M8 — distribution**, the last milestone before 1.0.0.

### Changed

- **Node.js 22 is now the minimum** (`engines.node: >=22`). Node 20 reached end-of-life in April 2026. CI tests Node 22 and 24; the GitHub Action runs on Node 22. Stay on mcpward 0.8.x if you cannot upgrade.
- **GitHub Action at the repository root**: use `uses: TsvetanG2/mcpward@<tag>`. The old path `TsvetanG2/mcpward/action@…` keeps working (the two definitions are kept identical by a test). Pin a release tag; from 1.0.0 a moving major tag (`@v1`) is maintained.
- The Action runs `npx --yes mcpward@<version>`, so installing the package never waits on an interactive prompt.
- The Action uses `actions/setup-node@v7`; v4 ran on the deprecated Node 20 Actions runtime and printed a deprecation warning in every consumer's workflow.

### Security

- **The PR-comment token reached the server under test.** With `pr-comment: true` the Action exports a write-capable token as `MCPWARD_GITHUB_TOKEN`, and mcpward passed its whole environment to stdio servers — so an untrusted server could read it. mcpward's own credentials (`MCPWARD_GITHUB_TOKEN`, `GITHUB_TOKEN`) are now withheld from the server's environment; a value set explicitly in `server.env` is still passed. Tested end-to-end with a fixture server that reports what it can see.

### Fixed

- **The Action reported success for an incomplete scan.** Only exit codes 1 and 2 failed the step; any other non-zero status (130 interrupted, 137 killed, 127 `npx` missing) left the step green. Every non-zero exit now fails it. A test runs the action's own shell script against a fake CLI for each exit code.

### Added

- **Action end-to-end workflow**: the Action is exercised as a user would run it — against fixture servers with a local build (outputs, exit codes 0/1, SARIF and JSON reports), and from a clean directory containing only `mcpward.yaml`, running the published package against a version-pinned real MCP server.
- The release workflow moves the major version tag (`v1`, …) to each 1.x+ release; its trigger is narrowed to exact versions (`v*.*.*`).
- `pnpm run format:check` runs in CI (Prettier, code only).

### Removed

- The unused `execa` dependency (its v10 requires Node 22 and it was never imported).

### Internal

- Upgraded vitest to 5.
- `.gitattributes` checks out text files with LF on every platform.

## [0.8.1] — 2026-10-05

Fixes from review of 0.8.0.

### Fixed

- **SARIF location relative to the wrong directory.** 0.8.0 made `artifactLocation.uri` relative to the current directory, but code scanning resolves it against the repository root — with the action's `working-directory` (or a run from a subfolder) alerts pointed outside the checkout. It is now relative to the repository root: `GITHUB_WORKSPACE` in Actions, else the nearest `.git` ancestor.
- **SARIF URI encoding.** Each path segment is percent-encoded, so a config named `checks#prod.yaml` is not read as a URI fragment and paths with spaces are valid URI references.
- **Config schema `server.url`.** The published schema used `format: "uri"`, which accepted `file:` and `ftp:` URLs the parser rejects, and rejected `${ENV_VAR}` placeholders the parser expands before validating (so editors flagged a valid config). It now accepts an http(s) URL (scheme case-insensitive, any hostname including internationalized ones, numeric port 0–65535) or a placeholder value that either supplies the scheme or follows a literal `http(s)://`. Rule: the schema never rejects a config the parser accepts; a test checks they agree on a list of edge-case URLs.

## [0.8.0] — 2026-10-05

This release implements **M7 — freeze the contract**. Everything a pipeline depends on is now written down, versioned, and validated against real output. See [`docs/stability.md`](docs/stability.md).

### Added

- **`schemaVersion` in the JSON report** (`1`). It changes only on a breaking change to the report shape; additive changes (new optional fields, rule ids, check families) do not bump it.
- **Published JSON Schemas**, shipped in the npm package under `schemas/`:
  - `schemas/report.v1.schema.json` — the JSON report
  - `schemas/config.v1.schema.json` — `mcpward.yaml`, **generated from the config parser** so it cannot drift (`pnpm run schemas`; a test fails if the committed file is stale)
  - `schemas/lockfile.v2.schema.json` — the baseline lockfile, including inferred output shapes
    Tests validate real `run` reports and real baselines against them, and assert they reject malformed input (a missing `schemaVersion`, an unknown status, a malformed hash, a credential-shaped fingerprint).
- **`docs/stability.md`** — what is public contract (exit codes, CLI, config, report, lockfile, rule ids, drift classes, SARIF/JUnit structure, Action inputs/outputs), what is not (human-readable text, result order, which findings a server produces), what counts as breaking, and the deprecation policy.
- `mcpward init` and `examples/mcpward.yaml` include a `yaml-language-server` schema comment, so editors validate and autocomplete the config.

### Changed

- **Report contract:** the JSON report has a new top-level `schemaVersion` field.

### Fixed

- **SARIF alerts pointed at `mcpward.yaml` regardless of `--config`.** `artifactLocation.uri` is now the repo-relative path of the config file actually used, so code-scanning alerts open the right file.

### Removed

- Legacy hyphenated SARIF rule-description keys (`drift/tool-added`, `drift/tool-removed`) that no emitted rule id used.

## [0.7.2] — 2026-10-05

Fixes from review of 0.7.1.

### Fixed

- **Security (drift):** description canonicalization used `String#trim()`, which also strips U+FEFF (a zero-width character) and Unicode spaces such as U+00A0. A zero-width character added at the start or end of a tool or parameter description was therefore invisible to drift — and `mcpward diff` does not run the separate raw security scan. Trimming is now ASCII-only. **Canonicalization version is now 2**: `diff` against an older baseline prints a warning; re-run `mcpward baseline` once. Only descriptions that begin or end with such characters hash differently.
- **Security (drift):** a parameter switching from `true` to an object schema that carries a description reported only a medium schema change, so instructions injected that way passed `fail_on: high`. The description is now reported as `description_changed`.
- **Schema drift:** a dropped tuple position is compared against the new `additionalItems` and an added one against the old `additionalItems` — including schema-valued `additionalItems`, which was misclassified as non-breaking.
- **False positive:** `true` and `{}` (or an annotation-only schema) accept the same values and are no longer reported as a breaking change.
- `mcpward baseline` again exits 2 when closing the server connection fails (0.7.1 swallowed the error).

## [0.7.1] — 2026-10-05

Fixes from review of 0.7.0.

### Fixed

- **Security:** adding a description to a parameter that had none was not reported. A parameter description that is added, removed or changed is now `description_changed` — the easiest rug-pull is writing instructions into a field that was empty.
- **False positive:** parameter descriptions are now compared in canonical form, so whitespace, line-ending or Unicode-normalization-only edits are not high-severity drift (zero-width characters still are).
- **Schema drift:** a schema without `type` accepts anything, so adding a `type` (e.g. array `items: {}` → `{type: "string"}`) is now breaking, and removing one non-breaking. It was classified the other way round.
- **Schema drift:** boolean subschemas are handled — a property changing to `false` (rejects everything) is breaking; `true` → a schema is breaking; the reverse is non-breaking.
- **Schema drift:** `required` names that are not declared in `properties` are now compared (e.g. array items gaining `required: ["tag"]`).
- **False positive:** removing a tuple position only relaxes the array unless `additionalItems: false`; adding one constrains it unless it was previously forbidden.
- **Golden snapshots / drift:** keys literally named `__proto__` were dropped by canonicalization, so a golden mismatch in such a field could pass and such a schema property was invisible to drift. They are ordinary keys now.
- **`run_ms`:** after the deadline fired, command cleanup could return before the server process was terminated, so the CLI exited and left a timed-out server running. Cleanup now waits for the same shutdown the deadline started.

## [0.7.0] — 2026-10-05

This release implements **M6 — keep the promises already made**. An audit after 0.6.0 found options that the docs and config accepted but the code ignored; for a testing tool, a silently ignored assertion is the worst kind of bug. All four are fixed, each with a test that fails without the fix.

### Fixed

- **`expect.golden` was accepted but never compared.** Behavioral cases with a golden snapshot now compare the tool's `content`, `structuredContent` and `isError` (key order ignored) against the file, which resolves relative to the config file. A **missing golden file fails** — it is never created implicitly. New `behavioral/golden` rule.
- **`timeouts.run_ms` was never enforced.** `run`, `diff` and `baseline` now end at `run_ms` with **exit 2** (the run is incomplete, so it neither passes nor fails). A server that stalls between calls can no longer hold CI until the job timeout.
- **Schema drift only compared top-level property types.** The drift truth table is now implemented in full, recursively (nested `properties`, array `items`, `additionalProperties`), with paths like `filter.status` and `rows[].id`:
  - breaking: `enum` value removed or `enum` added; min-bounds raised/added; max-bounds lowered/added; `pattern`/`format`/`const`/`multipleOf` added or changed; `uniqueItems` on; `additionalProperties` closed; `items` constraint added; `anyOf`/`oneOf`/`allOf` changed (conservative, and the message says so)
  - non-breaking: the reverse of each
  - a changed **parameter** description is `description_changed` (high) — the model reads it like the tool description
- **`mcpward diff` lacked the reporters of `run`.** It now supports `--reporter json|junit|sarif|markdown`, `--out` and `--pr-comment` through the same output path as `run`. Human-readable headers are printed only for the console reporter, so machine-readable stdout stays parseable.

### Added

- `mcpward run --update-golden` writes or refreshes golden snapshot files explicitly.

### Changed

- **Report contract:** `mcpward diff --json` now prints the full report object (like `run --json`) instead of a bare array of results.
- **Report contract:** new rule id `behavioral/golden`. Schema drift reports more findings than before for the same change set (nested and constraint-level changes that were previously invisible); existing baselines do not need to be recaptured.
- `JsonSchema.type` accepts an array of types, as JSON Schema allows.
- The GitHub Action's default `version` is now `0.7.0`.

### Internal

- New fixtures `drift/schema-v1` → `schema-v2` (one change per tool, plus an unchanged deep schema as the negative case).
- `run` and `diff` share one output module (report assembly, reporters, PR comment, run deadline).

## [0.6.0] — 2026-10-05

This release implements **M5 (PR comment)** and completes the roadmap.

### Added

- **PR comment (M5, #13)** — `mcpward run --pr-comment` posts the report as a pull request comment and updates the same comment on re-runs (hidden `<!-- mcpward-report -->` marker). Outside a PR it prints why and does nothing; posting failures warn on stderr and never change the exit code or stdout. Token: `MCPWARD_GITHUB_TOKEN` or `GITHUB_TOKEN` (needs `pull-requests: write`); it is registered as a secret so it never appears in output.
- **Markdown reporter** — `--reporter markdown`. Renders the same redacted model as every reporter, with word-level description diffs and invisible characters marked. Server-supplied text is escaped so it cannot inject HTML, links, or @-mentions. Also usable as a job summary: `--reporter markdown --out "$GITHUB_STEP_SUMMARY"`.
- **GitHub Action:** new inputs `pr-comment` (default `false`) and `github-token` (default `${{ github.token }}`); `reporter` accepts `markdown`.

### Changed

- **Report contract:** new reporter output format (Markdown), locked by a golden snapshot. Existing JSON/JUnit/SARIF shapes are unchanged.
- The GitHub Action's default `version` is now `0.6.0`.

### Fixed

Found in review of 0.4.0–0.5.0; these ship in 0.6.0.

- **Security:** a fake "flag" — U+1F3F4, an arbitrary smuggled sentence in Tag characters, U+E007F — was exempted as an emoji sequence. Only a valid ISO 3166-2 subdivision tag spec (e.g. `gbsct`) is exempt now.
- **Security:** hidden unicode and injection phrasing in **nested** parameter descriptions (nested objects, array `items`, `additionalProperties`, `anyOf`/`oneOf`/`allOf`) were not scanned.
- **Security:** a `nextCursor` of `""` ended pagination; only an absent cursor does now, so a server cannot hide later pages behind an empty cursor.
- **Output drift:** text → image content produced identical shapes; content block kinds are now tracked as fields. Output keys such as `constructor` or `__proto__` broke sampling; they are ordinary fields now.
- **PR comment:** the GitHub token was registered for redaction only after reports were rendered; it is registered before connecting.
- **PR comment:** bare URLs, `www.` hosts, e-mail addresses and @-mentions from the server could still be autolinked by GitHub; they are rendered as inline code.
- **PR comment:** a maintainer's token could overwrite a human comment that started with or quoted the marker; only a comment authored by the token's own identity is updated.
- **PR comment:** drift changes that do not fail the run (e.g. a breaking schema change under `fail_on: high`) were omitted from the comment; every contract change is listed.
- **PR comment:** the PR number is read from `MCPWARD_PR_NUMBER` (set by the action) or `GITHUB_REF`, never from the event file.
- Tests: the stdio/HTTP parity suite no longer needs `execa` (whose v10 requires Node 22) and runs on Node 20.

## [0.5.0] — 2026-10-05

This release implements **M4 (description collision lint)** — the check no other contract-diff tool performs.

### Added

- **Description collision lint (M4, #22 + #23)** — new `collision` check family, on by default, needs no baseline. Flags tool pairs whose descriptions are near-identical (offline character-trigram Dice, default threshold 0.8) **and** whose input schemas diverge (required-parameter _types_ or nesting depth differ). Tool families such as `list_users` / `list_projects` and `get_user(user_id)` / `get_project(project_id)` stay silent by design. Warns by default; `checks.collision.fail: true` fails the run. Skips with a warning above `max_tools` (default 500). The scorer sits behind an interface so an opt-in semantic scorer can be added later without network calls becoming the default.
- Config: `checks.collision` (`enabled`, `threshold`, `max_tools`, `fail`).

### Changed

- **Report contract:** new family `collision` and rule ids `collision/description-collision`, `collision/summary`, `collision/list-tools`. Findings are `warn` unless `checks.collision.fail: true`, so exit codes are unchanged for existing configs.
- `mcpward init` scaffolds the collision lint.
- The GitHub Action's default `version` is now `0.5.0`.

### Internal

- New fixture `collision-server`: one true collision and three negatives. A test asserts the negative family pairs score _above_ the threshold, so the schema gate — not the scorer — is what keeps them silent.
- No collision findings on the pinned reference servers (`server-filesystem`, `server-memory`, `server-everything`).

## [0.4.0] — 2026-10-05

This release implements **M3 (output shape drift)**, completes M2, adds **stdio ↔ HTTP parity** (the last v1 Definition-of-Done item), and fixes two false negatives in the security checks.

### Security

- **Paginated `tools/list` is now read in full.** Every check previously read only the first page, so a server could hide a poisoned tool on page 2 and get a clean report. All checks now follow `nextCursor` (with loop and page-count guards). Fixture: `paginated-server`.
- **Unicode Tag characters ("ASCII smuggling") are detected.** U+E0000–U+E007F are invisible and map 1:1 onto ASCII; they were not flagged at all. `security/hidden-unicode` now flags them and decodes the hidden text into the finding. Well-formed emoji tag sequences (subdivision flags) are not flagged. Fixture: `smuggling-server`.
- **Hidden unicode in parameter descriptions** is now flagged (previously only injection phrasing was checked there).
- **`mcpward diff` now redacts secrets** before output. The `--json` path printed results without passing through `redactReport`.
- **Server URLs are redacted** in `baseline`/`diff` console headers.
- **HTTP server URLs must be `http(s)`** (`file:`, `javascript:` etc. are rejected at config load).

### Added

- **Output shape drift (M3, #20)** — opt-in `checks.drift.output`. Infers each tool's output shape from real calls (`structuredContent`, JSON text, or content-block kinds), merged across `shape_samples` calls, and diffs structure only — never values.
  - New drift classes `breaking_output_shape_change` (medium) and `nonbreaking_output_shape_change` (low). Consumer-side semantics: a removed or newly-optional field, or a newly-appearing type, is breaking.
  - **Side-effect rule:** only tools annotated `readOnlyHint: true` (and not `destructiveHint: true`) that take no required arguments are called automatically; anything else must be allowlisted in `checks.drift.output.tools` with `args`. Every refused/skipped/failed tool is reported as `drift/output-sampling`.
  - Sample counts are recorded in every finding. Depth/width limits protect against hostile output.
  - Lockfile: optional `outputShape` per tool (additive; no `schemaVersion` bump).
- **Per-class severity overrides (M2)** — `checks.drift.severity: { tool_removed: high }`.
- **Word-level description diff (M2)** — the console shows `[-removed-]{+added+}` instead of only before/after. Long or hostile-size text falls back to before/after.
- **stdio ↔ Streamable HTTP parity** — tested: the same fixture over both transports produces identical normalized results for compliance, schema, security, error-contract and drift checks. `fixtures/http-host.ts` serves any fixture over HTTP.
- `docs/rules.md` documents every emitted rule id; a test harvests ids from the source and fails if one is undocumented.

### Changed

- **Report contract:** new rule ids `drift/breaking_output_shape_change`, `drift/nonbreaking_output_shape_change`, `drift/output-sampling`.
- **Report contract:** `server.protocolVersion` is now the version the server actually negotiated (it previously always reported the SDK's latest version).
- **Report contract:** the error-contract probe calls a fixed tool name `__mcpward_unknown_tool__` (previously suffixed with a timestamp), so reports are deterministic.
- **Report contract:** SARIF rules for `drift/tool_added`, `drift/tool_removed` and `drift/annotation_changed` now carry their real descriptions; `docs/rules.md` headings use the real (underscore) ids, so SARIF `helpUri` links for drift rules resolve.
- The default `fail_on` list includes `breaking_output_shape_change` (only produced when output drift is enabled).
- `mcpward init` scaffolds `fail_on: high` and links to the correct repository.
- The GitHub Action's default `version` is now `0.4.0` (was `0.1.0`).
- Upgraded `zod` 3 → 4 and `eslint` 10.
- GitHub Actions: third-party actions pinned to commit SHAs.

### Fixed

- **`mcpward baseline` exited 0 on failure** — it now exits 2 on config/connection errors like the other commands.
- **Short descriptions got no diff** — the console reporter used `length > 64` to tell text from a hash (`sha256:` + 64 hex is 71 characters), so descriptions under 64 characters fell back to plain expected/actual and hashes were rendered as text. Hashes are now matched exactly, with an explicit "full text unavailable" note.
- Per-call timeout timers were never cleared, keeping the event loop alive for up to `call_ms` after each call.
- `scripts/integration-baseline.mjs` crashed on re-run on Windows.

### Internal

- Integration baselines for `server-memory` and `server-everything` captured from real runs (were placeholders).
- New fixtures: `paginated-server`, `smuggling-server`, `drift/output-v1` → `output-v2`, `http-host.ts`.

## [0.3.0] — 2026-08-05

This release implements **M2 (Severity classification + description diffs)** from the roadmap. Adds a blast-radius-based severity axis separate from breaking/non-breaking classification, improved type change detection, and before/after description rendering with invisible character detection.

### Added

- **Severity axis (M2.1)** — Drift changes now include severity based on blast radius, NOT whether they break:
  - `high` — Silent security changes: `description_changed` (rug-pull), `annotation_changed` (permission expansion via readOnlyHint/destructiveHint flips)
  - `medium` — Loud schema breaks: `breaking_schema_change` (new required field, removed field, narrowed type)
  - `low` — Visible expected changes: `tool_added`, `tool_removed`, `nonbreaking_schema_change`
  - **CRITICAL**: `tool_removed` is **LOW** severity, not HIGH. Breaks loudly at call site and gets fixed in minutes. Not a silent security change.
- **Severity threshold config (M2.1)** — `fail_on` now accepts severity threshold OR drift class array:
  - `fail_on: 'high'` — Fail only on silent security changes (rug-pulls, permission expansion)
  - `fail_on: 'medium'` — Fail on high + medium (includes schema breaks)
  - `fail_on: 'low'` — Fail on everything
  - `fail_on: ['tool_removed', 'description_changed', ...]` — Legacy array mode still supported
- **Type change classification (M2.2)** — `diffSchema` now distinguishes:
  - Widening (`string` → `string|number`): `nonbreaking_schema_change`, low severity
  - Narrowing (`string|number` → `string`): `breaking_schema_change`, medium severity
  - Unrelated (`string` → `object`): `breaking_schema_change`, medium severity
- **Description diff rendering (M2.4)** — Console reporter now shows before/after description text for `description_changed` findings:
  - Truncates to 200 chars with explicit "… (truncated, see JSON report)" marker
  - Marks invisible characters (`<U+200B>` for zero-width space, `<U+202E>` for bidi overrides, etc.) for security visibility
  - **CRITICAL**: Renders RAW text, not canonical form, so zero-width rug-pulls are visible
  - JSON reporter includes full unabridged text in `expected`/`actual` fields
  - Falls back to hash when `full_text` disabled or baseline is v1

### Changed

- **`DriftChange` interface** — New required `severity: DriftSeverity` field. All drift changes now carry severity metadata.
- **`filterFailingChanges()` signature** — Now accepts `fail_on: string[] | 'high' | 'medium' | 'low'` (union type for backwards compatibility).
- **Drift-to-report severity mapping** — `src/checks/drift.ts` maps `DriftSeverity` (blast radius) → `CheckResult.Severity` (reporting level):
  - high → error, medium → warning, low → info
  - **Two separate axes**: Do NOT conflate drift severity (contract impact) with check severity (reporting level)

### Fixed

- **Type change over-classification** — Previous implementation treated all type changes as breaking. Now correctly classifies widening as non-breaking with low severity.

### Internal

- Added `classifyTypeChange()` helper in `src/surface/diff.ts` with heuristics for union type widening/narrowing detection
- Added `markInvisibleCharacters()` + `truncateText()` helpers in `src/report/console.ts` for safe description rendering
- Added `mapDriftSeverityToCheckSeverity()` in `src/checks/drift.ts` with explicit documentation of the two-axis model
- Updated `test/surface/diff.test.ts` with 13 new M2 tests:
  - 6 severity level tests (one per drift class)
  - 4 severity threshold filtering tests (high/medium/low + legacy array)
  - 3 type change classification tests (widening/narrowing/unrelated)
- Test count: 169 → 182 (all passing)

## [0.2.1] — 2026-08-05

Patch release fixing lint errors that blocked the v0.2.0 Release workflow, completing M1.2 (version consistency), and fixing environment-dependent golden snapshot tests.

### Fixed

- **ESLint errors in `src/surface/capture.ts` (P0)** — Fixed 3 lint errors that prevented npm publish:
  - Removed inferrable type annotation from `captureToolSurface()` parameter (`fullText = true` instead of `fullText: boolean = true`).
  - Restructured non-null assertions in `buildAuthContext()` to guard on array element instead of length (env and header branches). This satisfies `@typescript-eslint/no-non-null-assertion` without disabling the rule.
- **Version consistency (P1 — M1.2 completion)** — Created shared `src/version.ts` module as single source of truth for mcpward version. Fixed 5 hardcoded `'0.1.0'` strings that diverged from package.json:
  - `src/cli.ts` — `--version` command now reads from package.json
  - `src/client/connect.ts` — MCP handshake `clientInfo.version` (both stdio and HTTP transports)
  - `src/commands/run.ts` — Report header version
  - `src/commands/diff.ts` — Report header version
  - `src/surface/capture.ts` — Lockfile `meta.mcpwardVersion`
  - Added `test/version.test.ts` with 6 tests ensuring no hardcoded versions remain
- **Golden snapshot tests (P2)** — Fixed environment-dependent snapshots in `test/report/golden.test.ts`:
  - Set `NO_COLOR=1` in `vitest.config.ts` to disable picocolors deterministically
  - Regenerated console reporter snapshots to contain clean plaintext instead of ANSI escape codes
  - Tests now pass identically in CI (`CI=true`) and local environments

## [0.2.0] — 2026-08-05

This release combines **M0 (Canonicalization)** and **M1 (Lockfile v2)** from the roadmap. M0 eliminates false positives from formatting differences. M1 adds provenance tracking and auth-scoped baselines.

### Added

- **Canonicalization (M0)** — Tool descriptions and schemas are canonicalized before hashing to eliminate false positives from:
  - Reordered JSON keys
  - Different line endings (`\r\n` vs `\n`)
  - Different Unicode normalization (NFD vs NFC)
  - Whitespace variations
- **Lockfile v2 format (M1)** — New `schemaVersion: 2` with provenance tracking:
  - `target` — Server identity (command+args for stdio, origin+path for HTTP). Never includes secrets, env values, query strings, or headers.
  - `authContext` — Auth detection and fingerprinting. Detects auth from env vars (stdio) or headers (HTTP), computes stable sha256 fingerprint (truncated to 16 hex chars). **Never stores actual credentials.**
  - `environment` — CI detection, Node.js version, platform.
  - `description` — Full canonical description text stored in lockfile for before/after diffs (configurable via `checks.drift.full_text`, default `true`).
- **Auth-mismatch warning** — When comparing baselines captured under different credentials, emits `drift/auth-context-mismatch` warning explaining that drift may be due to different permissions.
- **V1 lockfile migration** — Lockfiles from v0.1.x load with default provenance values and a warning recommending re-baseline.
- **Canonical version tracking** — `canonicalVersion` field in lockfile metadata. When lockfile's canonical version differs from current, diff warns that comparison may produce artifacts.
- **Credential fingerprinting** — Stable non-reversible fingerprint (sha256 truncated to 16 chars) allows detecting "same credential as last time" without storing secrets in git-committed lockfile.

### Changed

- **Default baseline path** — Changed from `mcpward-drift.lock.json` to `mcpward.lock.json` (matches `mcpward baseline` default and aligns with config schema default).
- **`captureServerSurface()` API** — Now takes optional `Config` parameter for provenance tracking. Backwards compatible (config optional, uses defaults if not provided).
- **MCPWARD_VERSION** — Fixed hardcoded `0.1.0` in lockfile metadata. Now reads from `package.json` dynamically, so lockfiles correctly reflect the mcpward version that created them.

### Fixed

- **TypeScript version pinning** — Changed `^5.8.3` → `~5.9.3` to prevent TypeScript 7.x on fresh install (caret range was too loose). This is the same fix already applied in the Cognigy server repo.
- **False positives from formatting** — Servers that reorder JSON keys, switch line endings, or use different Unicode normalization no longer produce `description_changed` findings.
- **Zero-width character detection** — Canonicalization preserves zero-width and bidi characters so security checks (`security/hidden-unicode`) still detect tool poisoning. Verified by `poisoned-canonical` fixture.

### Breaking Changes

- **Lockfile format v1 → v2** — Schema change from v0.1.x. V1 lockfiles still load (migration with defaults + warning), but recommend running `mcpward baseline` to capture full provenance.
- **Default baseline path** — Renamed from `mcpward-drift.lock.json` to `mcpward.lock.json`. Existing configs with explicit `baseline` path are unaffected.

### Migration Guide

1. **Update lockfile** — Run `mcpward baseline` to update to v2 format with full provenance tracking.
2. **V1 lockfiles still work** — Old lockfiles load automatically with migration, but provenance fields (target, authContext, environment) will show "unknown". Re-baseline recommended.
3. **Rename baseline file (optional)** — If using default path, rename `mcpward-drift.lock.json` → `mcpward.lock.json`, or set explicit `checks.drift.baseline` in config.

## [0.1.0] — 2026-07-21

Initial release.

### Added

- **Black-box MCP client** over **stdio** and **Streamable HTTP** transports, built on the official `@modelcontextprotocol/sdk`. Tests any MCP server — including ones you did not write — given a command or a URL.
- **Compliance checks** — handshake, protocol version negotiation, server info, capability declaration, ping.
- **Schema checks** — tool name pattern, non-empty descriptions, JSON Schema validity of `inputSchema`, annotation validity, unique tool names.
- **Drift detection** — baseline snapshot to `mcpward.lock.json` and classified diffing: `tool_removed`, `tool_added`, `description_changed`, `breaking_schema_change`, `nonbreaking_schema_change`, `annotation_changed`, with configurable `fail_on`.
- **Rug-pull detection** — tool descriptions are hashed in the lockfile, so a silently mutated description is flagged as `description_changed` even when names and schemas are untouched.
- **Tool-poisoning heuristics** — injection-like phrasing, hidden/zero-width unicode, schemas soliciting secrets, and `readOnlyHint` mismatches on destructive tools.
- **Two-layer error contract checks** — distinguishes JSON-RPC protocol errors from tool-level `isError: true` results and asserts servers use the correct layer.
- **Behavioral test suites** — declarative YAML cases with JSONPath assertions, `tool_is_error` expectations, output-schema validation, and protocol error code assertions.
- **Latency budgets** — per-tool p50/p95 measurement against a configurable budget.
- **Reporters** — console, JSON, JUnit XML, and SARIF (for the GitHub Security tab).
- **CLI** — `init`, `run`, `baseline`, `diff`, with `--reporter`, `--out`, `--verbose`.
- **Exit codes** — `0` all passed, `1` one or more checks failed, `2` configuration or connection error.
- **GitHub composite Action** for one-step CI integration.
- `${ENV_VAR}` interpolation in config for secrets and tokens.

[Unreleased]: https://github.com/TsvetanG2/mcpward/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/TsvetanG2/mcpward/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/TsvetanG2/mcpward/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/TsvetanG2/mcpward/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/TsvetanG2/mcpward/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/TsvetanG2/mcpward/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/TsvetanG2/mcpward/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/TsvetanG2/mcpward/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/TsvetanG2/mcpward/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/TsvetanG2/mcpward/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/TsvetanG2/mcpward/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/TsvetanG2/mcpward/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/TsvetanG2/mcpward/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/TsvetanG2/mcpward/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/TsvetanG2/mcpward/compare/92456c2327bb5effbe546b89ab21955b9f661d2f...v0.6.0
[0.5.0]: https://github.com/TsvetanG2/mcpward/compare/43cb0dd2fc7a769d240fdb2006bb3076b3c7b6f7...92456c2327bb5effbe546b89ab21955b9f661d2f
[0.4.0]: https://github.com/TsvetanG2/mcpward/compare/v0.3.0...43cb0dd2fc7a769d240fdb2006bb3076b3c7b6f7
[0.3.0]: https://github.com/TsvetanG2/mcpward/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/TsvetanG2/mcpward/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/TsvetanG2/mcpward/compare/v0.1.1...v0.2.0
[0.1.0]: https://www.npmjs.com/package/mcpward/v/0.1.0
