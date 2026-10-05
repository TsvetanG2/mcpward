# mcpward — contract testing for MCP servers, in CI

[![CI](https://github.com/TsvetanG2/mcpward/actions/workflows/ci.yml/badge.svg)](https://github.com/TsvetanG2/mcpward/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mcpward)](https://www.npmjs.com/package/mcpward)
[![npm downloads](https://img.shields.io/npm/dm/mcpward)](https://www.npmjs.com/package/mcpward)
[![node version](https://img.shields.io/node/v/mcpward)](https://www.npmjs.com/package/mcpward)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Featured on VibeLeaderboard](https://img.shields.io/endpoint?url=https%3A%2F%2Fwww.vibeleaderboard.ai%2Fapi%2Fv1%2Fapps%2F5af89df6-6c01-4715-a462-67ef41513c5a%2Fbadge)](https://www.vibeleaderboard.ai/app/5af89df6-6c01-4715-a462-67ef41513c5a)

Treat an MCP server like any other external dependency: snapshot its contract, then fail the build when it changes underneath you. Black-box, so it works against servers you didn't write. **Runs entirely on your machine — no account, no API calls, no telemetry.**

Catches schema drift, silently changed tool descriptions, protocol violations, error-contract mistakes, and tool-poisoning patterns. Reports to console, JSON, JUnit, SARIF or Markdown, and can post the result as a pull-request comment.

![mcpward catching a rug-pull, a readOnlyHint flip and a breaking schema change](docs/demo.gif)

## Requirements

- Node.js ≥ 22
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
  ✗ Drift detected: 4 failing change(s) out of 6 total
  ✗ Tool "removed_tool" was removed
  ✗ Tool "echo" description changed (possible rug-pull)
    description diff:
      [-Original-]{+Modified+} description: [-echoes-]{+now+} [-back-]{+it+} {+also logs +}the [-message.-]{+message internally.+}
  ✗ Tool "compute" inputSchema added required property "multiplier"
  ✗ Tool "read_data" readOnlyHint changed from true to false (tool may now mutate state)

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
| Required field added / field removed / type narrowed / enum tightened / bound tightened / pattern added — at any depth | `breaking_schema_change` | medium | yes |
| Output field removed / new output type / output format changed (inferred, opt-in) | `breaking_output_shape_change` | medium | yes |
| Tool removed | `tool_removed` | low | yes |
| Tool added | `tool_added` | low | no |
| Optional field added / type widened / enum or bound loosened — at any depth | `nonbreaking_schema_change` | low | no |
| Output field added (inferred, opt-in) | `nonbreaking_output_shape_change` | low | no |

**Severity is blast radius, not breakage.** A removed tool is breaking but *low*: it fails loudly at the call site and gets fixed in minutes. A `readOnlyHint` flip is *high*: it silently changes what clients auto-approve, and nobody notices.

**Concrete examples:** A tool gains a new required `multiplier` parameter → `breaking_schema_change` (existing calls will fail). A tool adds an optional `limit` parameter → `nonbreaking_schema_change` (callers can ignore it). A parameter's type widens from `string` to `string | number` → `nonbreaking_schema_change`; narrowing the other way → `breaking_schema_change`. An `enum` loses a value, `maxLength` drops from 100 to 10, or `filter.status` gains a `pattern` → `breaking_schema_change`. A description — of the tool or of any parameter — gains one zero-width character → `description_changed`, and the diff shows it as `<U+200B>`.

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

**Description collisions** are caught on first contact, with no baseline. Two tools with near-identical descriptions but different payloads — one takes a nested `filter` object, the other a flat `status` string — make an agent pick confidently and wrong, and no success/error check can see it. mcpward flags a pair only when the descriptions are near-identical **and** the input schemas diverge, so ordinary tool families like `list_users` / `list_projects` stay silent. Similarity is computed offline; no model or API calls.

**Two-layer error contract** deserves a note, because nothing else checks it. MCP distinguishes protocol errors (a JSON-RPC `error` object) from tool errors (a *successful* result carrying `isError: true`). A tool that fails its job should return the second, not the first. Servers get this backwards routinely, and it changes how a client must handle the failure.

## Where mcpward fits

MCP tooling splits into three jobs. Pick the one you actually have:

| Job | Use |
|---|---|
| Poke a server by hand and see what it does | [MCP Inspector](https://github.com/modelcontextprotocol/inspector), [MCPJam](https://github.com/MCPJam/inspector) |
| Audit the agents, MCP servers and skills installed on your machine | [Snyk Agent Scan](https://github.com/snyk/agent-scan) (formerly mcp-scan) |
| Test a server as a dependency, in CI, and fail the build when its contract changes | **mcpward** |

### Compared to Snyk Agent Scan (formerly mcp-scan)

[Agent Scan](https://github.com/snyk/agent-scan) — mcp-scan from Invariant Labs, now maintained by Snyk — is excellent and considerably more mature. Invariant Labs' research is what named tool poisoning and rug pulls in MCP. If your question is *"are the agents, MCP servers and skills installed on my machine safe?"*, use Agent Scan. It discovers the configs of Claude, Cursor, VS Code, Windsurf and other agents, scans agent skills, can install runtime hooks (Agent Guard), and detects tool shadowing and toxic flows, which mcpward does not do at all.

mcpward answers a different question: *"did this server's contract change since my last release?"*

| | mcpward | Agent Scan |
|---|---|---|
| Primary use | CI gate on a dependency | Audit your installed agents and servers |
| Baseline + drift (rug-pull) detection | yes, lockfile committed to your repo | keeps local scan state; no documented baseline/diff workflow |
| Tool-poisoning heuristics | yes, local pattern matching | yes (stronger, model-backed analysis) |
| Tool shadowing / toxic flows | no | yes |
| Agent skills scanning | no | yes |
| Runtime hooks for agents | no | yes (Agent Guard) |
| Protocol compliance checks | yes | no |
| Two-layer error contract | yes | no |
| Behavioral test suites | yes | no |
| Latency budgets | yes | no |
| CI output | JUnit, SARIF, JSON, Markdown, PR comment | JSON, `--ci` exit code |
| Runs fully offline | yes | no — needs a Snyk API token and sends tool names, descriptions and server configs to the Snyk API (secrets redacted) |

That last row is the practical reason to reach for mcpward on internal or client-owned servers: **nothing leaves your machine.** No account, no API key, no service to trust.

### Compared to other CI-oriented tools

| Feature | mcpward | [mcpvet](https://github.com/holydement0r/mcpvet) | [MCP Contract CI](https://github.com/ajpeng/MCP-Contract-CI) |
|---|---|---|---|
| Description-level drift | yes | no | no |
| Input schema drift | yes | yes | yes |
| Output schema drift | yes (opt-in) | no | yes |
| Prompt and resource drift | no | no | yes |
| Breaking vs non-breaking classification | yes | breaking only | breaking only |
| Protocol compliance | yes | partial (stdout corruption) | no |
| Schema lint | yes | yes | no |
| Two-layer error contract | yes | no | no |
| Tool-poisoning heuristics | yes | no (on roadmap) | no |
| Behavioral test suites | yes | yes | yes (saved tool-call replay) |
| Latency budgets | yes (p50/p95) | per-call limit | no |
| SARIF export | yes | no | no |
| JUnit output | yes | yes | no |
| PR comment | yes | no | yes |
| Live server over HTTP | yes | yes | no (stdio replay, manifest diff) |

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

A stdio server inherits mcpward's environment — except mcpward's own credentials (`MCPWARD_GITHUB_TOKEN`, `GITHUB_TOKEN`), which are always withheld — plus anything in `server.env`. When testing a server you do not trust, keep unrelated secrets out of that job's environment; see [`SECURITY.md`](SECURITY.md#environment-of-a-stdio-server).

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
| `compliance/expected-protocol-version` | Negotiated version matches `expect.protocol_version` (when set) |

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
| `behavioral/golden` | Output matches its golden snapshot (`--update-golden` to refresh) |

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
  uses: actions/upload-artifact@v7
  with:
    name: mcpward-results
    path: results.xml

# SARIF output for GitHub Security tab (the job needs `permissions: security-events: write`)
- name: Run with SARIF output
  run: npx mcpward run --reporter sarif --out results.sarif

- name: Upload SARIF to GitHub Security
  uses: github/codeql-action/upload-sarif@v4
  with:
    sarif_file: results.sarif
```

Findings appear in the repository's **Security → Code scanning** tab, with rule descriptions and remediation guidance from [`docs/rules.md`](docs/rules.md).

```yaml
# Using the mcpward action
- name: Run mcpward
  uses: TsvetanG2/mcpward@v1
  with:
    config: mcpward.yaml
    reporter: junit
    output: results.xml
```

`@v1` always points to the latest 1.x release, which never breaks the public contract ([`docs/stability.md`](docs/stability.md)). Pin an exact tag (`@v1.0.0`) to control upgrades yourself. The action's `version` input defaults to the release it belongs to, so the action and the CLI it runs always match. The older path `TsvetanG2/mcpward/action@…` keeps working.

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
      - uses: actions/checkout@v7
      - uses: TsvetanG2/mcpward@v1
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
| `2` | Configuration or connection error, or `timeouts.run_ms` exceeded — nothing (or not everything) was tested |

The distinction between `1` and `2` matters: `2` means the run never completed, which should be treated differently from a genuine failure.

## Machine-readable formats

The JSON report, the config file and the baseline lockfile each have a published JSON Schema, shipped in the npm package under `schemas/`:

| File | Schema | Version field |
|---|---|---|
| JSON report (`--reporter json`) | [`schemas/report.v1.schema.json`](schemas/report.v1.schema.json) | `schemaVersion` |
| `mcpward.yaml` | [`schemas/config.v1.schema.json`](schemas/config.v1.schema.json) | — |
| Baseline lockfile | [`schemas/lockfile.v2.schema.json`](schemas/lockfile.v2.schema.json) | `meta.schemaVersion` |

`mcpward init` adds a `yaml-language-server` comment so editors validate and autocomplete `mcpward.yaml`. What is (and is not) covered by compatibility guarantees is described in [`docs/stability.md`](docs/stability.md).

## Roadmap

- **Registry-published tool-surface hashes** — verify a server against a hash published by its registry, once registries publish them ([#21](https://github.com/TsvetanG2/mcpward/issues/21))
- **Opt-in semantic scorer for the collision lint** — a local embedding model or bring-your-own endpoint behind the existing scorer interface; the offline lexical scorer stays the default
- **Resources and prompts** — the contract checks cover tools today; extend snapshots and drift to `resources/list` and `prompts/list`
- **Supply chain / server identity** — the contract pins tool names and schemas, not the implementation; capturing binary or container digest alongside the contract is a future direction

## Articles

- [Pin your MCP server contracts the way you pin your dependencies](https://dev.to/tsvetang2/pin-your-mcp-server-contracts-the-way-you-pin-your-dependencies-43j8) — dev.to
- [MCP servers are becoming infrastructure](https://mcpward.hashnode.dev/mcp-servers-are-becoming-infrastructure-how-do-we-know-that-the-contract-an-ai-agent-trusts-today-is-the-same-contract-it-will-receive-tomorrow) — Hashnode
- [MCP servers are becoming infrastructure](https://medium.com/@t.gerginov/mcp-servers-are-becoming-infrastructure-c64ed86241fb) — Medium
- [I kept worrying about MCP servers silently changing…](https://www.reddit.com/r/mcp/comments/1v7kbyx/i_kept_worrying_about_mcp_servers_silently/) — discussion on r/mcp

## Development

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run lint
pnpm run typecheck      # src and tests
pnpm run format:check   # Prettier (code only)
pnpm run schemas        # regenerate schemas/config.v1.schema.json after changing the config
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the testing rules (every check needs a fixture that makes it fail).

## License

MIT
