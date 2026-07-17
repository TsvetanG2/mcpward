 Daw# mcpward — catch rug-pulls, tool poisoning, and schema drift in your MCP servers before your agents do.

[![CI](https://github.com/anthropics/mcpward/actions/workflows/ci.yml/badge.svg)](https://github.com/anthropics/mcpward/actions/workflows/ci.yml)
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

## How We Differ

| Feature | mcpward | mcpvet | MCP-Contract-CI |
|---------|---------|--------|-----------------|
| **Rug-pull by description mutation** | ✅ | ❌ | ❌ |
| **Two-layer error contract** | ✅ | ❌ | ❌ |
| **Tool-poisoning heuristics** | ✅ | ❌ | ❌ |
| **SARIF output (GitHub Security)** | ✅ | ❌ | ❌ |
| Protocol compliance checks | ✅ | ✅ | ❌ |
| Schema validation | ✅ | ✅ | ✅ |
| Drift detection | ✅ | ✅ | ✅ |
| JUnit output | ✅ | ✅ | ❌ |
| stdio transport | ✅ | ✅ | ✅ |
| HTTP transport | ✅ | ✅ | ❌ |

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

## CI Integration

### GitHub Actions

```yaml
- name: Run mcpward
  run: npx mcpward run --reporter junit --out mcpward-results.xml

- name: Upload test results
  uses: actions/upload-artifact@v4
  with:
    name: mcpward-results
    path: mcpward-results.xml

# For security findings in GitHub Security tab:
- name: Run mcpward security checks
  run: npx mcpward run --reporter sarif --out mcpward.sarif

- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: mcpward.sarif
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All checks passed |
| `1` | One or more checks failed |
| `2` | Configuration or connection error |

## License

MIT
