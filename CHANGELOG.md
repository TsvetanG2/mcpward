# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until `1.0.0`, minor versions may contain breaking changes to the config format. The **report shapes (JSON/JUnit/SARIF) and exit codes are treated as a public contract** and changes to them are always called out explicitly.

## [Unreleased]

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

[Unreleased]: https://github.com/TsvetanG2/mcpward/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TsvetanG2/mcpward/releases/tag/v0.1.0
