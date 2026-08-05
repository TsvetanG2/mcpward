# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until `1.0.0`, minor versions may contain breaking changes to the config format. The **report shapes (JSON/JUnit/SARIF) and exit codes are treated as a public contract** and changes to them are always called out explicitly.

## [Unreleased]

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

[Unreleased]: https://github.com/TsvetanG2/mcpward/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/TsvetanG2/mcpward/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/TsvetanG2/mcpward/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/TsvetanG2/mcpward/releases/tag/v0.1.0
