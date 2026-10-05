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

| Change | Classification | Severity | Fails by default? |
|--------|----------------|----------|-------------------|
| Description changed | `description_changed` | high | yes |
| `readOnlyHint` true→false or `destructiveHint` false→true | `annotation_changed` | high | yes |
| Required field added / field removed / narrowed or unrelated type change | `breaking_schema_change` | medium | yes |
| Output field removed / new output type / output format changed (inferred, opt-in) | `breaking_output_shape_change` | medium | yes |
| Tool removed | `tool_removed` | low | yes |
| Tool added | `tool_added` | low | no |
| Optional field added / type widened | `nonbreaking_schema_change` | low | no |
| Output field added (inferred, opt-in) | `nonbreaking_output_shape_change` | low | no |

**Severity is blast radius, not breakage.** A removed tool is breaking but *low*: it fails loudly at the call site and gets fixed in minutes. A `readOnlyHint` flip is *high*: it silently changes what clients auto-approve, and nobody notices.

**Concrete examples:** A tool gains a new required `multiplier` parameter → `breaking_schema_change` (existing calls will fail). A tool adds an optional `limit` parameter → `nonbreaking_schema_change` (callers can ignore it). A parameter's type widens from `string` to `string | number` → `nonbreaking_schema_change`; narrowing the other way → `breaking_schema_change`. A description gains one zero-width character → `description_changed`, and the diff shows it as `<U+200B>`.

### Policy: choosing what fails CI

The `fail_on` setting is your policy engine. Fail on a severity threshold (recommended) or list the classes explicitly:

```yaml
checks:
  drift:
    baseline: ./mcpward.lock.json
    fail_on: high          # only silent security changes fail; schema breaks and removals report
    # fail_on: medium      # high + schema/output breaks
    # fail_on: [tool_removed, description_changed, breaking_schema_change, annotation_changed]
    severity:              # optional per-class overrides
      tool_removed: high
```

Some teams fail on any description change; others only on removals. Encode your tolerance here. See [`docs/rules.md`](docs/rules.md) for the full rule reference.

### Output drift (opt-in)

Input drift breaks at the call site; output drift is silent until something downstream chokes. Many servers declare no `outputSchema`, so mcpward can **infer** each tool's output shape from real calls and diff the structure (fields, types, nesting — never values):

```yaml
checks:
  drift:
    output:
      enabled: true
      shape_samples: 3      # calls per tool; shapes are merged, so optional fields aren't "missing"
      tools:                # explicit allowlist, with arguments
        - name: get_order
          args: { id: "demo-1" }
```

This **calls tools**, so mcpward refuses to call anything that might have side effects: only tools annotated `readOnlyHint: true` that need no arguments are called automatically, plus whatever you allowlist. Every refused or skipped tool is reported with the reason.

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
| Rug-pull / description drift | yes | yes |
| Tool-poisoning heuristics | yes | yes (stronger, research-backed) |
| Cross-origin escalation / tool shadowing | no | yes |
| Live proxy + runtime guardrails | no | yes |
| Protocol compliance checks | yes | no |
| Two-layer error contract | yes | no |
| Behavioral test suites | yes | no |
| Latency budgets | yes | no |
| JUnit + SARIF for CI | yes | no |
| Runs fully offline, no data leaves your machine | yes | ** shares tool names and descriptions with invariantlabs.ai ** |

That last row is the practical reason to reach for mcpward on internal or client-owned servers: **nothing leaves your machine.** No account, no API key, no service to trust.

### Compared to other CI-oriented tools

| Feature | mcpward | mcpvet | MCP-Contract-CI |
|---|---|---|---|
| Description-level drift | yes | no | no |
| Schema drift detection | yes | yes | yes |
| Breaking vs non-breaking classification | yes | partial | yes |
| Protocol compliance | yes | yes | no |
| Two-layer error contract | yes | no | no |
| Tool-poisoning heuristics | yes | no | no |
| SARIF export | yes | no | no |
| JUnit output | yes | yes | no |
| Behavioral test suites | yes | no | yes |
| Latency budgets | yes | no | no |
| HTTP transport | yes | yes | no |

**Description collisions** are caught on first contact, with no baseline. Two tools with near-identical descriptions but different payloads — one takes a nested `filter` object, the other a flat `status` string — make an agent pick confidently and wrong, and no success/error check can see it. mcpward flags a pair only when the descriptions are near-identical **and** the input schemas diverge, so ordinary tool families like `list_users` / `list_projects` stay silent. Similarity is computed offline; no model or API calls.

**Two-layer error contract** deserves a note, because nothing else checks it. MCP distinguishes protocol errors (a JSON-RPC `error` object) from tool errors (a *successful* result carrying `isError: true`). A tool that fails its job should return the second, not the first. Servers get this backwards routinely, and it changes how a client must handle the failure.

## Features

- **Classifies every schema change as breaking or non-breaking** — fails CI only on the ones you configure, reports the rest
- **Detects description rewrites (rug-pulls)** — hashes canonicalized descriptions and shows a word-level diff with invisible characters marked
- **Ranks drift by blast radius** — high/medium/low severity, `fail_on: high` to fail only on silent security changes
- **Catches tool-poisoning patterns** — injection phrasing, hidden unicode (including Unicode Tag "ASCII smuggling", decoded for you), secret-soliciting schemas, annotation mismatches — in tool and parameter descriptions
- **Lints description collisions** — near-identical descriptions over divergent schemas, no baseline needed
- **Detects output shape drift** — inferred from real (read-only or allowlisted) calls, structure only
- **Validates error contracts** — verifies servers use protocol errors vs tool errors correctly (unique to mcpward)
- **Runs behavioral test suites** — declarative cases with JSONPath assertions against tool outputs
- **Enforces latency budgets** — fails when p95 exceeds your threshold
- **stdio and Streamable HTTP** — identical results over both transports, tested for parity; paginated `tools/list` is read in full
- **Outputs JUnit, SARIF, JSON and Markdown** — plus an opt-in PR comment that updates in place
- **Works fully offline** — no accounts, no API calls, nothing leaves your machine (the PR comment talks only to your own GitHub API, and only when you enable it)

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
    fail_on: high            # or medium / low, or a list of drift classes
    severity: {}             # per-class overrides, e.g. { tool_removed: high }
    full_text: true          # store description text in the lockfile for diffs
    output:                  # output shape drift — opt-in, calls tools
      enabled: false
      shape_samples: 3
      call_readonly: true    # auto-call readOnlyHint tools that take no arguments
      tools: []              # allowlist: [{ name: get_order, args: { id: "demo-1" } }]
  collision:                 # description collision lint — on by default
    enabled: true
    threshold: 0.8           # description similarity (0–1)
    max_tools: 500           # skip with a warning above this (pairwise is O(n²))
    fail: false              # true = collisions fail the run instead of warning
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
| `golden` | string | Path (relative to the config file) to a golden snapshot of the tool's output. A missing file fails; create or refresh it with `mcpward run --update-golden`. Deterministic tools only. |

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
| `security/hidden-unicode` | Zero-width, bidirectional, or Unicode Tag (ASCII smuggling) characters in names, descriptions, or parameter descriptions |
| `security/secret-in-schema` | Schema fields soliciting secrets |
| `security/annotation-mismatch` | readOnlyHint on destructive tools |

### Drift

See [How changes are classified](#how-changes-are-classified) for the full classification table and policy configuration.

### Collision

| Check | Description |
|-------|-------------|
| `collision/description-collision` | Near-identical descriptions over divergent input schemas (required-param types or nesting depth differ) |
| `collision/summary` | Pairs checked, or skipped above `max_tools` |

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

### PR comment

Post the classified report — drift with severity, before/after description diffs, collisions — as a pull request comment. Re-runs update the same comment instead of stacking new ones; outside a pull request it does nothing.

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  mcpward:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: TsvetanG2/mcpward/action@main
        with:
          config: mcpward.yaml
          pr-comment: true
```

Without the action: `GITHUB_TOKEN=${{ github.token }} npx mcpward run --pr-comment`. The comment is rendered from the same redacted report as every other reporter, and all server-supplied text is escaped so a malicious tool description cannot inject links, HTML, or @-mentions into your PR.

The same Markdown works as a job summary: `npx mcpward run --reporter markdown --out "$GITHUB_STEP_SUMMARY"`.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All checks passed |
| `1` | One or more checks failed |
| `2` | Configuration or connection error — nothing was tested |

The distinction between `1` and `2` matters: `2` means the run never happened, which should be treated differently from a genuine failure.

## Roadmap

- **Registry-published tool-surface hashes** — verify a server against a hash published by its registry, once registries publish them ([#21](https://github.com/TsvetanG2/mcpward/issues/21))
- **Opt-in semantic scorer for the collision lint** — a local embedding model or bring-your-own endpoint behind the existing scorer interface; the offline lexical scorer stays the default
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
