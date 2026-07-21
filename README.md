# mcpward — contract testing for MCP servers, in CI

[![CI](https://github.com/TsvetanG2/mcpward/actions/workflows/ci.yml/badge.svg)](https://github.com/TsvetanG2/mcpward/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mcpward)](https://www.npmjs.com/package/mcpward)
[![npm downloads](https://img.shields.io/npm/dm/mcpward)](https://www.npmjs.com/package/mcpward)
[![node version](https://img.shields.io/node/v/mcpward)](https://www.npmjs.com/package/mcpward)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Treat an MCP server like any other external dependency: snapshot its contract, then fail the build when it changes underneath you. Black-box, so it works against servers you didn't write. **Runs entirely on your machine — no account, no API calls, no telemetry.**

Catches schema drift, silently changed tool descriptions, protocol violations, error-contract mistakes, and tool-poisoning patterns. Reports to console, JSON, JUnit, or SARIF.

<!-- TODO: add docs/demo.gif — baseline → diff showing rug-pull, breaking schema change, readOnlyHint flip -->

## Requirements

- Node.js ≥ 20
- An MCP server to test (stdio or HTTP transport)

## Installation

Run without installing:

```bash
npx mcpward init
```

Or install globally:

```bash
npm install -g mcpward
mcpward --version
```

Requires Node.js ≥ 20. Works against MCP servers written in any language, over stdio or Streamable HTTP.

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

**Pin the contract, then catch it changing.**

```bash
$ mcpward baseline
✓ Connected to drift-server v1.0.0
✓ Captured 6 tool(s)
✓ Baseline saved to mcpward.lock.json
```

The server ships an update. In CI:

```bash
$ mcpward diff

DRIFT (5 failed)
  ✗ Tool "echo" description changed (possible rug-pull)
  ✗ Tool "compute" inputSchema added required property "multiplier"
  ✗ Tool "read_data" readOnlyHint changed from true to false (tool may now mutate state)
  ✗ Tool "removed_tool" was removed

Summary: 2 passed | 5 failed

$ echo $?
1
```

Four contract changes, none of which would surface at runtime until something broke.

**When security issues are found:**

```
SECURITY (9 failed)
  ✗ Tool "injection_tool" description contains injection-like pattern:
    "Ignore all previous instructions"
  ✗ Tool "safe​tool" name contains hidden unicode: U+200B (zero-width)
  ✗ Tool "api_connector" schema solicits secrets: api_key, password
  ✗ Tool "delete_files" has readOnlyHint=true but name implies mutation

Summary: 10 passed | 9 failed
```

**When all checks pass:**

```
mcpward v0.1.0
──────────────────────────────────────────────────
Server: my-server v1.0.0
Protocol: 2025-11-25

COMPLIANCE (5 passed)
SCHEMA (13 passed)
SECURITY (1 passed)

Summary: 19 passed
All checks passed
```

## Why mcpward?

Your agent calls `tools/list` and trusts whatever comes back. Tool descriptions are not documentation — they are the instructions the model reads to decide what a tool does. So when a server you depend on ships an update, four things can change without any signal reaching you:

- a tool's **description** is rewritten (same name, same schema — nothing else catches this)
- a **required parameter** appears, and your existing calls start failing
- **`readOnlyHint`** flips from `true` to `false`, so a tool you allow-listed can now mutate state
- a tool **disappears**

mcpward pins the server's contract to a lockfile and fails your build when it drifts — the same discipline you already apply to every other dependency.

## Where mcpward fits

MCP tooling splits into three jobs. Pick the one you actually have:

| Job | Use |
|---|---|
| Poke a server by hand and see what it does | [MCP Inspector](https://github.com/modelcontextprotocol/inspector), [MCPJam](https://github.com/MCPJam/inspector) |
| Audit the servers installed on your machine for malicious behaviour | [mcp-scan](https://github.com/invariantlabs-ai/mcp-scan) |
| Test a server as a dependency, in CI, and fail the build when its contract changes | **mcpward** |

### Compared to mcp-scan

[mcp-scan](https://github.com/invariantlabs-ai/mcp-scan) is excellent and considerably more mature — Invariant Labs' research is what named tool poisoning and rug pulls in MCP, and their tool-pinning has detected description changes via hashing since April 2025. If your question is *"are the MCP servers installed on my machine safe?"*, use mcp-scan. It scans Claude, Cursor, and Windsurf configs, offers a proxy mode with live guardrails, and detects cross-origin escalation (tool shadowing), which mcpward does not do at all.

mcpward answers a different question: *"did this server's contract change since my last release?"*

| | mcpward | mcp-scan |
|---|---|---|
| Primary use | CI gate on a dependency | Audit your installed servers |
| Rug-pull / description drift | ✅ | ✅ |
| Tool-poisoning heuristics | ✅ | ✅ (stronger, research-backed) |
| Cross-origin escalation / tool shadowing | ❌ | ✅ |
| Live proxy + runtime guardrails | ❌ | ✅ |
| Protocol compliance checks | ✅ | ❌ |
| Two-layer error contract | ✅ | ❌ |
| Behavioral test suites | ✅ | ❌ |
| Latency budgets | ✅ | ❌ |
| JUnit + SARIF for CI | ✅ | ❌ |
| Runs fully offline, no data leaves your machine | ✅ | ⚠️ shares tool names and descriptions with invariantlabs.ai |

That last row is the practical reason to reach for mcpward on internal or client-owned servers: **nothing leaves your machine.** No account, no API key, no service to trust.

### Compared to other CI-oriented tools

| Feature | mcpward | mcpvet | MCP-Contract-CI |
|---|---|---|---|
| Description-level drift | ✅ | ❌ | ❌ |
| Schema drift detection | ✅ | ✅ | ✅ |
| Breaking vs non-breaking classification | ✅ | partial | ✅ |
| Protocol compliance | ✅ | ✅ | ❌ |
| Two-layer error contract | ✅ | ❌ | ❌ |
| Tool-poisoning heuristics | ✅ | ❌ | ❌ |
| SARIF export | ✅ | ❌ | ❌ |
| JUnit output | ✅ | ✅ | ❌ |
| Behavioral test suites | ✅ | ❌ | ✅ |
| Latency budgets | ✅ | ❌ | ❌ |
| HTTP transport | ✅ | ✅ | ❌ |

**Two-layer error contract** deserves a note, because nothing else checks it. MCP distinguishes protocol errors (a JSON-RPC `error` object) from tool errors (a *successful* result carrying `isError: true`). A tool that fails its job should return the second, not the first. Servers get this backwards routinely, and it changes how a client must handle the failure.

See [`docs/rules.md`](docs/rules.md) for every check mcpward performs and what each finding means.

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

Full reference for every rule, with remediation guidance: [`docs/rules.md`](docs/rules.md).

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
```

Findings appear in the repository's **Security → Code scanning** tab, with rule descriptions and remediation guidance from [`docs/rules.md`](docs/rules.md).

```yaml
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
| `2` | Configuration or connection error — nothing was tested |

The distinction between `1` and `2` matters: `2` means the run never happened, which should be treated differently from a genuine failure.

## Development

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run lint
```

## License

MIT
