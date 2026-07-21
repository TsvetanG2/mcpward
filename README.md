# mcpward — catch rug-pulls, tool poisoning, and schema drift in your MCP servers before your agents do.

[![CI](https://github.com/TsvetanG2/mcpward/actions/workflows/ci.yml/badge.svg)](https://github.com/TsvetanG2/mcpward/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcpward)](https://www.npmjs.com/package/mcpward)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Black-box security & contract testing for MCP servers. Runs locally and in CI with deterministic, machine-readable reports (console / JSON / JUnit / SARIF).

<!-- TODO: Add asciinema demo showing rug-pull + poisoned tool detection -->

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

## Why mcpward?

MCP servers are consumed as black boxes by AI agents. Between versions, a tool's description can silently change (a "rug-pull"), schemas can break, or descriptions can carry injection payloads. Your agent breaks—or gets hijacked—with no signal.

**mcpward catches these problems before production.**

### What makes it different

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
- **Multiple reporters** — console, JSON, SARIF
- **CI-friendly** — exit codes `0`/`1`/`2`, machine-readable output

### Coming Soon

- HTTP transport
- JUnit output
- GitHub Action wrapper

## Configuration

Create `mcpward.yaml`:

```yaml
server:
  transport: stdio
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/sandbox"]
  env: {}

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
- name: Run mcpward
  run: npx mcpward run

- name: Run with SARIF output
  run: npx mcpward run --reporter sarif --out results.sarif

- name: Upload SARIF to GitHub Security
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: results.sarif
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
