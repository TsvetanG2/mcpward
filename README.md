# mcpward — catch rug-pulls, tool poisoning, and schema drift in your MCP servers before your agents do.

[![CI](https://github.com/TsvetanG2/mcpward/actions/workflows/ci.yml/badge.svg)](https://github.com/TsvetanG2/mcpward/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcpward)](https://www.npmjs.com/package/mcpward)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Black-box security & contract testing for MCP servers. Runs locally and in CI with deterministic, machine-readable reports (console / JSON / JUnit / SARIF).

<!-- TODO: Add asciinema demo showing rug-pull + poisoned tool detection -->

## Features

### Implemented ✅
- **Protocol compliance checks** — handshake, version negotiation, capabilities, ping
- **Schema validation** — tool names, descriptions, inputSchema (JSON Schema)
- **Console & JSON reporters** — pretty terminal output + machine-readable JSON
- **Exit codes** — `0` pass, `1` fail, `2` config error (CI-friendly)
- **stdio transport** — connect to any MCP server via subprocess

### Coming Soon 🚧
- **Rug-pull detection** — catch silent description/schema mutations between versions
- **Tool-poisoning heuristics** — detect injection patterns, hidden unicode, secret-soliciting schemas
- **SARIF output** — surface findings in GitHub Security tab
- **Drift detection** — baseline snapshots + breaking change classification
- **HTTP transport** — connect to remote MCP servers
- **Behavioral testing** — declarative test suites with assertions
- **Latency budgets** — p50/p95 checks
- **JUnit output** — for CI test result integration

## Quick Start

```bash
# Initialize config
npx mcpward init

# Run all checks
npx mcpward run

# Capture baseline for drift detection (coming soon)
npx mcpward baseline

# Check for drift against baseline (coming soon)
npx mcpward diff
```

## How We Differ

| Feature | mcpward | mcpvet | MCP-Contract-CI |
|---------|---------|--------|-----------------|
| **Rug-pull by description mutation** | 🚧 | ❌ | ❌ |
| **Two-layer error contract** | 🚧 | ❌ | ❌ |
| **Tool-poisoning heuristics** | 🚧 | ❌ | ❌ |
| **SARIF output (GitHub Security)** | 🚧 | ❌ | ❌ |
| Protocol compliance checks | ✅ | ✅ | ❌ |
| Schema validation | ✅ | ✅ | ✅ |
| Drift detection | 🚧 | ✅ | ✅ |
| JUnit output | 🚧 | ✅ | ❌ |
| stdio transport | ✅ | ✅ | ✅ |
| HTTP transport | 🚧 | ✅ | ❌ |

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
  security: true  # coming soon
  drift:          # coming soon
    baseline: ./mcpward.lock.json
    fail_on:
      - tool_removed
      - description_changed
      - breaking_schema_change
      - annotation_changed
  latency:        # coming soon
    samples: 5
    p95_budget_ms: 1000

# Behavioral test suites (coming soon)
suites:
  - tool: read_file
    cases:
      - name: reads an existing file
        args: { path: "/tmp/sandbox/hello.txt" }
        expect:
          tool_is_error: false
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

## Current Checks

### Compliance (`compliance/*`)
| Check | Description |
|-------|-------------|
| `compliance/handshake` | Protocol handshake completed successfully |
| `compliance/protocol-version` | Valid protocol version negotiated |
| `compliance/server-info` | Server name and version present |
| `compliance/capabilities` | Server declares capabilities |
| `compliance/ping` | Server responds to ping |

### Schema (`schema/*`)
| Check | Description |
|-------|-------------|
| `schema/tool-name` | Tool names match `^[a-zA-Z0-9_-]+$` |
| `schema/tool-description` | Tools have non-empty descriptions |
| `schema/tool-input-schema` | Valid JSON Schema with `type: "object"` |
| `schema/tool-annotations` | Annotation values are valid |
| `schema/unique-names` | No duplicate tool names |

## CI Integration

### GitHub Actions

```yaml
- name: Run mcpward
  run: npx mcpward run

- name: Run mcpward (JSON output)
  run: npx mcpward run --json --out mcpward-results.json

- name: Upload results
  uses: actions/upload-artifact@v4
  with:
    name: mcpward-results
    path: mcpward-results.json
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All checks passed |
| `1` | One or more checks failed |
| `2` | Configuration or connection error |

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Run tests
pnpm run test

# Lint
pnpm run lint
```

## License

MIT
