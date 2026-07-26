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

Works against MCP servers written in any language, over stdio or Streamable HTTP.

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

## How changes are classified

Not every change should fail a build. Adding an optional parameter is safe; adding a required one breaks existing callers. The classifier encodes this judgment as a pure function with exhaustive fixture-backed tests.

| Change | Classification | Fails by default? |
|--------|----------------|-------------------|
| Tool removed | `tool_removed` | yes |
| Tool added | `tool_added` | no |
| Description changed | `description_changed` | yes |
| Required field added / field removed / type changed | `breaking_schema_change` | yes |
| Optional field added | `nonbreaking_schema_change` | no |
| `readOnlyHint` true→false or `destructiveHint` false→true | `annotation_changed` | yes |

**Concrete examples:** A tool gains a new required `multiplier` parameter → `breaking_schema_change` (existing calls will fail). A tool adds an optional `limit` parameter → `nonbreaking_schema_change` (callers can ignore it). An optional field becomes required → `breaking_schema_change`. A field is removed entirely → `breaking_schema_change` (callers may rely on it).

### Policy: choosing what fails CI

The `fail_on` setting is your policy engine — it decides which change classes fail the build and which only report:

```yaml
checks:
  drift:
    baseline: ./mcpward.lock.json
    fail_on:
      - tool_removed
      - description_changed
      - breaking_schema_change
      - annotation_changed
      # tool_added and nonbreaking_schema_change will report but not fail
```

Some teams fail on any description change; others only on removals. Encode your tolerance here. See [`docs/rules.md`](docs/rules.md) for the full rule reference.

## Why mcpward?

Your agent calls `tools/list` and trusts whatever comes back. Tool descriptions are not documentation — they are the instructions the model reads to decide what a tool does. When a server you depend on ships an update, four things can change without any signal reaching you:

- a tool's **description** is rewritten (same name, same schema — nothing else catches this)
- a **required parameter** appears, and your existing calls start failing
- **`readOnlyHint`** flips from `true` to `false`, so a tool you allow-listed can now mutate state
- a tool **disappears**

mcpward pins the server's contract to a lockfile and fails your build when it drifts — the same discipline you already apply to every other dependency.

**Security checks** catch tool-poisoning patterns before they reach your agent:

```
SECURITY (9 failed)
  ✗ Tool "injection_tool" description contains injection-like pattern:
    "Ignore all previous instructions"
  ✗ Tool "safe​tool" name contains hidden unicode: U+200B (zero-width)
  ✗ Tool "api_connector" schema solicits secrets: api_key, password
  ✗ Tool "delete_files" has readOnlyHint=true but name implies mutation
```

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

## Features

- **Classifies every schema change as breaking or non-breaking** — fails CI only on the ones you configure, reports the rest
- **Detects description rewrites (rug-pulls)** — hashes tool descriptions; catches silent changes that text diffs miss
- **Catches tool-poisoning patterns** — injection phrasing, hidden unicode, secret-soliciting schemas, annotation mismatches
- **Validates error contracts** — verifies servers use protocol errors vs tool errors correctly (unique to mcpward)
- **Runs behavioral test suites** — declarative cases with JSONPath assertions against tool outputs
- **Enforces latency budgets** — fails when p95 exceeds your threshold
- **Outputs JUnit + SARIF** — integrates with GitHub Actions test results and Security tab
- **Works fully offline** — no accounts, no API calls, nothing leaves your machine

See [`docs/rules.md`](docs/rules.md) for every check mcpward performs and what each finding means.

## Configuration

Create `mcpward.yaml`:

```yaml
server:
  transport: stdio
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/sandbox"]
  env: {}

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

See [How changes are classified](#how-changes-are-classified) for the full classification table and policy configuration.

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

## Roadmap

- **PR comment reporting** — post classified drift as a reviewable comment next to the code diff ([#13](https://github.com/TsvetanG2/mcpward/issues/13))
- **Show old vs new text for description changes** — surface the actual diff, not just "description changed" ([#14](https://github.com/TsvetanG2/mcpward/issues/14))
- **Canonicalization audit** — normalize tool surface before hashing to avoid false-positive drift ([#12](https://github.com/TsvetanG2/mcpward/issues/12))
- **Constraint-level schema analysis** — detect narrowed `maxItems`, removed `enum` values, and other JSON Schema constraint changes (currently property-level only)
- **Supply chain / server identity** — the contract pins tool names and schemas, not the implementation; capturing binary or container digest alongside the contract is a future direction

## Development

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run lint
```

## License

MIT