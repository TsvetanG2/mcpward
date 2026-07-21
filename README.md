# mcpward — catch rug-pulls, tool poisoning, and schema drift in your MCP servers before your agents do.

[![CI](https://github.com/TsvetanG2/mcpward/actions/workflows/ci.yml/badge.svg)](https://github.com/TsvetanG2/mcpward/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mcpward)](https://www.npmjs.com/package/mcpward)
[![npm downloads](https://img.shields.io/npm/dm/mcpward)](https://www.npmjs.com/package/mcpward)
[![node version](https://img.shields.io/node/v/mcpward)](https://www.npmjs.com/package/mcpward)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Black-box security & contract testing for MCP servers. Runs locally and in CI with deterministic, machine-readable reports (console / JSON / JUnit / SARIF).

<!-- Demo placeholder: Will show rug-pull + poisoned tool detection in CI -->
![mcpward demo](docs/demo.gif "mcpward catching a rug-pull and poisoned tool in CI")

## Requirements

- Node.js ≥ 20
- An MCP server to test (stdio or HTTP transport)

## Quick Start

```bash
# Initialize config
npx mcpward init

# Run all checks
npx mcpward run

# Capture baseline for drift detection
npx mcpward baseline

# Check for drift against baseline
npx mcpward diff
```

### Example Output

When checks pass:

```
mcpward v0.1.0
──────────────────────────────────────────────────
Server: my-server v1.0.0
Protocol: 2025-11-25

COMPLIANCE (5 passed)
  5 check(s) passed

SCHEMA (13 passed)
  13 check(s) passed

SECURITY (1 passed)
  1 check(s) passed

Summary: 19 passed
All checks passed
```

When security issues are found:

```
SECURITY (9 failed)
  ✗ Tool "injection_tool" description contains injection-like pattern:
    "Ignore all previous instructions"
  ✗ Tool "safe​tool" name contains hidden unicode: U+200B (zero-width)
  ✗ Tool "api_connector" schema solicits secrets: api_key, password
  ✗ Tool "delete_files" has readOnlyHint=true but name implies mutation

Summary: 10 passed | 9 failed
9 check(s) failed
```

## Why mcpward?

MCP servers are consumed as black boxes by AI agents. Between versions, a tool's description can silently change (a "rug-pull"), schemas can break, or descriptions can carry injection payloads. Your agent breaks—or gets hijacked—with no signal.

**mcpward catches these problems before production.**

### How we differ

| Feature | mcpward | mcpvet | MCP-Contract-CI |
|---------|---------|--------|-----------------|
| Rug-pull (description mutation) | ✅ | ❌ | ❌ |
| Tool-poisoning heuristics | ✅ | ❌ | ❌ |
| SARIF export (GitHub Security) | ✅ | ❌ | ❌ |
| Two-layer error contract | ✅ | ❌ | ❌ |
| Schema drift detection | ✅ | ✅ | ✅ |
| JUnit output | ✅ | ✅ | ❌ |
| Behavioral test suites | ✅ | ❌ | ✅ |
| HTTP transport | ✅ | ✅ | ❌ |

**Rug-pull detection** — Other tools catch when a tool is renamed or removed. mcpward also detects when a tool's *description* silently changes. Descriptions are hashed in the lockfile; any mutation is flagged as `description_changed`.

**Tool-poisoning heuristics** — Static analysis detects injection-like phrasing ("ignore previous instructions"), hidden unicode characters, schemas soliciting secrets (`api_key`, `password`), and `readOnlyHint` mismatches. Findings export to SARIF for GitHub Security tab.

**Two-layer error contract** — MCP has two error types: protocol errors (JSON-RPC) and tool errors (`isError: true`). mcpward verifies servers use the right layer for the right situation.

**Behavioral test suites** — Declarative YAML test cases with JSONPath assertions, `tool_is_error` checks, and latency budgets.

## Features

- **Protocol compliance** — handshake, version negotiation, capabilities, ping
- **Schema validation** — tool names, descriptions, inputSchema (JSON Schema)
- **Drift detection** — baseline snapshots with breaking change classification
- **Security heuristics** — injection patterns, hidden unicode, secret-soliciting schemas
- **Behavioral testing** — declarative test suites with assertions
- **Latency budgets** — p50/p95 percentile checks
- **Multiple reporters** — console, JSON, JUnit, SARIF
- **CI-friendly** — exit codes `0`/`1`/`2`, machine-readable output
- **HTTP transport** — connect to remote MCP servers
- **GitHub Action** — ready-to-use composite action

## Configuration

Create `mcpward.yaml`:

```yaml
server:
  transport: stdio
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/sandbox"]
  env: {}

# Optional: Timeout configuration
timeouts:
  connect_ms: 10000    # Connection timeout (default: 10s)
  call_ms: 30000       # Per-tool-call timeout (default: 30s)
  run_ms: 300000       # Total run timeout (default: 5min)

checks:
  compliance: true
  schema: true
  security: true
  drift:
    baseline: ./mcpward.lock.json
    fail_on:
      - tool_removed
      - description_changed
      - breaking_schema_change
      - annotation_changed
  latency:
    samples: 5
    p95_budget_ms: 1000

suites:
  - tool: read_file
    cases:
      - name: reads an existing file
        args: { path: "/tmp/sandbox/hello.txt" }
        expect:
          tool_is_error: false
          jsonpath:
            "$.content[0].type": "text"
      - name: returns error for missing file
        args: { path: "/nonexistent" }
        expect:
          tool_is_error: true
```

### Environment Variables

Use `${ENV_VAR}` syntax for secrets:

```yaml
server:
  transport: http
  url: https://example.com/mcp
  headers:
    Authorization: "Bearer ${MCP_TOKEN}"
```

### Behavioral Test Expectations

The `expect` block in test cases supports:

| Option | Type | Description |
|--------|------|-------------|
| `tool_is_error` | boolean | Assert the tool response has `isError: true/false` |
| `protocol_error_code` | number | Assert a JSON-RPC error code (e.g., -32602) |
| `jsonpath` | object | Assert values at JSONPath locations |
| `output_matches_schema` | boolean | Validate output against tool's outputSchema |
| `golden` | string | Path to golden snapshot file for comparison |

## Check Families

### Compliance

| Check | Description |
|-------|-------------|
| `compliance/handshake` | Protocol handshake completed |
| `compliance/protocol-version` | Valid protocol version negotiated |
| `compliance/server-info` | Server name and version present |
| `compliance/capabilities` | Server declares capabilities |
| `compliance/ping` | Server responds to ping |

### Schema

| Check | Description |
|-------|-------------|
| `schema/tool-name` | Names match `^[a-zA-Z0-9_-]+$` |
| `schema/tool-description` | Non-empty descriptions |
| `schema/tool-input-schema` | Valid JSON Schema |
| `schema/tool-annotations` | Valid annotation values |
| `schema/unique-names` | No duplicate names |

### Security

| Check | Description |
|-------|-------------|
| `security/injection-pattern` | Injection-like phrasing in descriptions |
| `security/hidden-unicode` | Zero-width or bidirectional characters |
| `security/secret-in-schema` | Schema fields soliciting secrets |
| `security/annotation-mismatch` | readOnlyHint on destructive tools |

### Drift

| Change | Classification | Default fail? |
|--------|----------------|---------------|
| Tool removed | `tool_removed` | yes |
| Tool added | `tool_added` | no |
| Description changed | `description_changed` | yes |
| Required field added / type narrowed | `breaking_schema_change` | yes |
| Optional field added / type widened | `nonbreaking_schema_change` | no |
| readOnlyHint true→false | `annotation_changed` | yes |

### Behavioral

| Check | Description |
|-------|-------------|
| `behavioral/tool-is-error` | Assert `isError` matches expectation |
| `behavioral/jsonpath` | Assert values at JSONPath locations |
| `behavioral/output-schema` | Validate output against schema |
| `behavioral/protocol-error` | Assert protocol error codes |

### Latency

| Check | Description |
|-------|-------------|
| `latency/summary` | Overall p50/p95 vs budget |
| `latency/tool` | Per-tool latency measurements |

## CI Integration

### GitHub Actions

```yaml
# Basic usage
- name: Run mcpward
  run: npx mcpward run

# JUnit output for test results
- name: Run with JUnit output
  run: npx mcpward run --reporter junit --out results.xml

- name: Upload test results
  uses: actions/upload-artifact@v4
  with:
    name: mcpward-results
    path: results.xml

# SARIF output for GitHub Security tab
- name: Run with SARIF output
  run: npx mcpward run --reporter sarif --out results.sarif

- name: Upload SARIF to GitHub Security
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: results.sarif

# Using the mcpward action
- name: Run mcpward
  uses: TsvetanG2/mcpward/action@main
  with:
    config: mcpward.yaml
    reporter: junit
    output: results.xml
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All checks passed |
| `1` | One or more checks failed |
| `2` | Configuration or connection error |

## Development

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run lint
```

## License

MIT
