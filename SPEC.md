# mcpward — MVP Spec

> **What this is:** `mcpward` is a CLI-first, **black-box**, framework-agnostic harness that validates any running MCP server (one you wrote or one you didn't) over stdio or Streamable HTTP. It leads with **security + contract testing**: it catches protocol violations, tool-schema drift, **rug-pulls** (silently mutated tool descriptions/schemas between versions), **tool-poisoning** patterns, error-contract regressions, and latency-budget violations — and runs both locally and in CI with deterministic, machine-readable reports (console / JSON / JUnit / SARIF).

> **Prime directive (read this first, every phase):** This is **not** another visual MCP Inspector. `modelcontextprotocol/inspector` (~10k★) and `MCPJam/inspector` (~2k★) already own interactive/manual debugging. `fastmcp` owns in-process unit-testing of servers *you author*. Our moat is the combination none of them cover: **black-box** (talks to any server as a client), **security-first drift/rug-pull/tool-poisoning detection**, **declarative contract assertions**, and **CI-native output** (exit codes + JUnit/SARIF). If a proposed feature could be described as "a nicer inspector UI," it is out of scope. Keep the tool headless, deterministic, and CI-shaped.

---

## 1. Positioning & why this exists

MCP servers are consumed as black boxes by agents. Between two versions of the same server, a tool's description or input schema can silently change (a "rug-pull"), a tool can vanish, an `annotations.readOnlyHint` can flip to destructive, a description can carry an injection payload (tool poisoning), or error behavior can drift — and the consuming agent breaks (or gets hijacked) in production with no signal. There is today (mid-2026) **no established CI-grade security+contract harness** for this.

**Target users:** MCP server authors who want a regression + security gate in CI; teams that *consume* third-party MCP servers and want to pin and verify their behavior; security-minded users who want rug-pull / tool-poisoning detection with SARIF in GitHub code scanning.

---

## 2. Prior art & how we differ (do not just rebuild this)

Seed competitors exist but none has traction (all 0–2★, first-committed mid-2026). Copying them wins nothing; our wedge is the **security-first combination they lack**.

| Project | Lang | What it does | What it lacks (our opening) |
|---|---|---|---|
| **mcpvet** | Python | lint + snapshot/diff + `test --format junit` over stdio/HTTP; catches rename/type/drop drift | No **description-level rug-pull**, no **two-layer error contract**, no **tool-poisoning/SARIF** |
| **MCP-Contract-CI** | Node | manifest diff + saved tool-call replay; breaking changes only | No compliance suite, no rug-pull-by-description, no latency, no security |
| **mcp-probe** | Python | deliberately tiny demo/starter | Not a product |
| **mcp-dyno** | Node | LLM-in-the-loop *quality* benchmarking (cost/tokens/correctness) | Different category; complementary, not competing |
| `mcp.com.ai` eval skill | — | curl+jq eval workflow, lead-gen for a platform | Not a standalone CI harness |

**Our three differentiators — build and market these first:**
1. **Rug-pull by description mutation** — detect when a tool's *description* silently changes between versions (competitors catch rename/type/drop, not the actual social-engineering vector). Hash descriptions in the lockfile.
2. **Two-layer error contract** — verify protocol errors (JSON-RPC `error`) vs tool errors (`isError: true`) are used correctly. Nobody else checks this.
3. **Tool-poisoning heuristics + SARIF** — injection phrasing / hidden unicode / secret-soliciting schemas / annotation-behavior mismatch, surfaced in GitHub code scanning. This is the traffic driver; security tools spread.

---

## 3. MVP scope

**In scope (v1):**
- Connect to a server as a real MCP client over **stdio** and **Streamable HTTP**.
- Protocol-compliance checks (handshake, version negotiation, JSON-RPC correctness, capability consistency).
- Tool/resource/prompt **schema validation**.
- **Baseline snapshot** (lockfile) + **drift/rug-pull diff** with breaking/non-breaking classification, incl. description-hash rug-pull.
- **Tool-poisoning security heuristics** → SARIF (this is core, not a stretch).
- **Declarative behavioral suites** (call tool → assert on result/error/output-schema/latency).
- **Error-contract** checks (protocol errors vs tool-level `isError` — see §5).
- **Latency budgets**.
- Reporters: pretty console, JSON, **JUnit XML**, **SARIF**; correct **exit codes**.
- `init` scaffolding + a GitHub Action wrapper.

**Out of scope for v1 (park these):** GUI / web dashboard / hosted service · OAuth beyond a static bearer token to the HTTP transport · exercising `sampling`/`elicitation`/`completions`/`roots` (validate their *declaration* only) · multi-server orchestration · hosted baseline registry · pytest plugin (post-MVP channel — keep the core engine reusable so it's easy later).

---

## 4. Tech stack & rationale

| Concern | Choice | Why |
|---|---|---|
| Language | **TypeScript** (Node ≥ 20) | MCP's most mature client SDK is TS; `npx mcpward` zero-install distribution is the ecosystem norm; you already publish to npm. The tool is language-agnostic in *what it tests* — it black-boxes servers written in any language. |
| MCP client | `@modelcontextprotocol/sdk` (official) | Test against the **real** protocol, never a hand-rolled reimplementation. Non-negotiable for legitimacy. |
| JSON Schema | `ajv` + `ajv-formats` | Validate `inputSchema`/`outputSchema` and validate call args/outputs. |
| Config validation | `zod` | Typed YAML config with good errors. |
| Config format | YAML (`yaml`); lockfile JSON | Human-authored suites; machine-authored baseline. |
| Subprocess | `execa` | Spawn stdio servers; clean teardown. |
| Deep diff | `microdiff` or small custom differ | Typed surface diffs for drift. |
| CLI | `commander` | Subcommands, help, flags. |
| Output | `picocolors` | Zero-dep color. |
| Our test runner | `vitest` | TS-native, snapshot support for golden report tests. |
| Lint/format | `eslint` + `prettier` | Standard. |
| Package manager | `pnpm` | Fast, strict. |
| License | **MIT** | Max adoption; matches local-first/zero-lock-in ethos. |

**Distribution:** `npx mcpward`-runnable npm package + a thin GitHub composite Action.

---

## 5. Core concepts (get these right — they are the product)

### 5.1 The two-layer error contract (critical MCP nuance)
- **Protocol errors** → JSON-RPC **error object** (`code`/`message`). Standard codes: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal. Use for: unknown tool, malformed `tools/call`, structurally invalid params.
- **Tool-execution errors** → **successful result** with `isError: true` and error content. A tool failing its job (file not found, upstream 500) must **not** be a JSON-RPC error.

`mcpward` lets users assert on **both layers separately** (`protocol_error_code` vs `tool_is_error`). Verifying a server uses the right layer for the right failure is itself a valuable, unique contract check.

### 5.2 Check families
1. **Compliance** — `initialize` handshake; sane negotiated `protocolVersion`; declared `capabilities` consistent with reality; valid JSON-RPC framing; `ping`.
2. **Schema** — valid `inputSchema`/`outputSchema`; unique names matching `^[a-zA-Z0-9_-]+$`; non-empty descriptions; well-formed annotations.
3. **Drift / rug-pull** — snapshot surface → lockfile; diff later; classify (§7.2), incl. description-hash rug-pull.
4. **Security (tool-poisoning)** — static analysis of the surface → SARIF (§5.3).
5. **Behavioral** — declarative cases: call tool, assert on result; optional golden snapshots for deterministic tools.
6. **Error contract** — invalid params ⇒ correct protocol error code; tool failure ⇒ `isError: true` (not a protocol error).
7. **Latency budget** — p50/p95 across N samples vs budget.

**Never hardcode the protocol version.** Read whatever the SDK negotiates and treat it as data (assert against a user-configured expectation if provided).

### 5.3 Tool-poisoning heuristics (the differentiator)
Flag, with SARIF locations: imperative/injection-like phrasing in tool or parameter descriptions ("ignore previous", "before doing X, first…", instructions aimed at the model); zero-width / bidi / hidden unicode in any description or name; input schemas soliciting secrets (`api_key`, `password`, `token`, private keys) without justification; `readOnlyHint: true` on a tool whose name/description implies mutation. Tune for **zero false positives on the good-server fixture** — a security check that cries wolf is worse than none.

---

## 6. Architecture & repo structure

```
mcpward/
├── src/
│   ├── cli.ts                # commander entrypoint (init, run, baseline, diff)
│   ├── config/{schema.ts,load.ts}       # zod schema + loader (+ ${ENV} interpolation)
│   ├── client/{connect.ts,transports.ts}# MCP client via official SDK; stdio (execa) + HTTP
│   ├── checks/{compliance,schema,drift,security,behavioral,errors,latency}.ts
│   ├── surface/{capture.ts,diff.ts}     # snapshot → lockfile; typed diff + classifier
│   ├── assert/{jsonpath.ts,jsonschema.ts}
│   ├── report/{model.ts,console.ts,json.ts,junit.ts,sarif.ts}
│   └── index.ts              # programmatic API (so a pytest plugin/CI can embed later)
├── fixtures/                 # THE legitimacy engine — see §9
│   ├── good-server/          # fully compliant, fast, clean
│   ├── malformed-server/     # bad JSON-RPC, wrong error codes, crashes
│   ├── drift/{v1,v2}/        # controlled change pairs (one per class)
│   ├── slow-server/          # blows the latency budget
│   └── poisoned-server/      # injection text / hidden unicode / secret-soliciting schema
├── test/                     # vitest: unit + integration + negative + golden
├── action/                   # GitHub composite action
├── examples/                 # sample config + suite
├── CLAUDE.md                 # project memory for Claude Code
├── README.md
└── package.json
```

**Design rule:** every check produces the **same normalized result object** (`{id, family, status: pass|fail|warn, severity, message, expected, actual, location}`). Reporters only read that model — keeps console/JSON/JUnit/SARIF consistent and makes exit-code logic trivial.

---

## 7. Config & lockfile formats

### 7.1 `mcpward.yaml` (user-authored)
```yaml
server:
  transport: stdio                 # stdio | http
  command: npx                     # stdio only
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/sandbox"]
  env: { LOG_LEVEL: "error" }
  # transport: http
  # url: "https://example.com/mcp"
  # headers: { Authorization: "Bearer ${MCP_TOKEN}" }

expect:
  protocol_version: "2025-06-18"   # optional; omit to accept whatever is negotiated

checks:
  compliance: true
  schema: true
  security: true                   # tool-poisoning heuristics → SARIF
  drift:
    baseline: ./mcpward.lock.json
    fail_on: [tool_removed, breaking_schema_change, description_changed, annotation_changed]
  latency:
    samples: 5
    p95_budget_ms: 800

suites:
  - tool: read_file
    cases:
      - name: reads an existing file
        args: { path: "/tmp/sandbox/hello.txt" }
        expect:
          tool_is_error: false
          output_matches_schema: true
          jsonpath: { "$.content[0].type": "text" }
      - name: invalid params are a protocol error
        args: {}
        expect: { protocol_error_code: -32602 }
      - name: missing file is a tool error, not a protocol error
        args: { path: "/tmp/sandbox/nope" }
        expect: { tool_is_error: true }
```

### 7.2 `mcpward.lock.json` (machine-authored baseline) + drift classifier

```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": { "tools": {}, "resources": {} },
  "tools": {
    "read_file": {
      "descriptionHash": "sha256:9f2c…",
      "inputSchema": { "...": "verbatim" },
      "outputSchema": null,
      "annotations": { "readOnlyHint": true }
    }
  }
}
```

| Change observed | Class | Default `fail_on`? |
|---|---|---|
| In lock, absent now | `tool_removed` | yes (breaking) |
| Absent in lock, present now | `tool_added` | no (info) |
| `descriptionHash` changed | `description_changed` (rug-pull) | yes |
| Added **required** field / removed field / narrowed type / tightened enum | `breaking_schema_change` | yes |
| Added **optional** field / widened type / loosened constraint | `nonbreaking_schema_change` | no (info) |
| `readOnlyHint` true→false, or `destructiveHint` false→true | `annotation_changed` | yes |
| `outputSchema` removed/narrowed (added/widened) | breaking (non-breaking) | breaking→yes |

Implement the classifier as a **pure function** with an exhaustive fixture-backed test (§9).

---

## 8. CLI surface
```
mcpward init                  # scaffold mcpward.yaml + example suite
mcpward run [--config f]      # run all configured checks; exit non-zero on failure
mcpward baseline [--config f] # capture current surface → lockfile
mcpward diff [--config f]     # drift check only; print classified diff
Global: --reporter console|json|junit|sarif  --out <path>  --json  --verbose
```
**Exit codes:** `0` all pass · `1` one or more checks failed · `2` config/connection error. Document this contract; CI depends on it.

---

## 9. How to test mcpward LEGITimately (this makes or breaks trust)

A green suite means nothing unless you've proven it can go **red** for the right reasons. Enforce all six.

### 9.1 Ground-truth fixture servers (the core technique)
Build controlled fixture MCP servers with the official SDK whose correct/incorrect status **you define**:

| Fixture | Encodes (ground truth) | Proves |
|---|---|---|
| `good-server` | Fully compliant; correct two-layer errors; fast; clean descriptions | **All pass**; zero false positives (esp. security) |
| `malformed-server` | Invalid JSON-RPC, wrong error codes, protocol error where `isError` is required, crashes on bad input | Each compliance/error check **fails with the right message** |
| `drift/v1`→`drift/v2` | Exactly one change of each §7.2 class (incl. a silent description edit) | Classifier labels each change **correctly** |
| `slow-server` | Delay above budget | Latency check **fails**; good-server **passes** |
| `poisoned-server` | Injection text + zero-width unicode + `api_key`-soliciting schema | Security heuristics **trip**; good-server stays clean |

### 9.2 Assert-it-can-fail (negative tests mandatory)
Every check needs a test that feeds a known-bad fixture and asserts a **failure** (right `id`, `severity`, message). A check that can't go red is a bug.

### 9.3 Unit-test the pure logic exhaustively
Diff/classifier (every §7.2 row as a case), schema wrappers, JSONPath, config parser, exit-code logic, security matchers. No coverage theater — target the classifier, error-layer, and security matchers.

### 9.4 Golden/snapshot the reports
Snapshot JSON + JUnit + SARIF for a canonical fixture run; report-shape changes become conscious decisions.

### 9.5 Integration against real, pinned servers
Run against `server-filesystem`, `server-memory`, `server-everything` via `npx` with **pinned versions**. Separate, slower suite; run on schedule + release.

### 9.6 Both transports + CI matrix
stdio *and* Streamable HTTP produce identical normalized results for equivalent servers. CI matrix: Node 20/22 × Linux+macOS. Gate merges on unit+fixture+negative+golden green.

### 9.7 Dogfood
CI runs `mcpward` against its own fixtures and publishes JUnit — smoke test + living docs.

---

## 10. Phase plan

Each phase ends **green in CI** with acceptance criteria met and tests written **with** the feature. Do not advance until the phase's fixtures + negative tests are legit.

### Phase 0 — Scaffolding & the black-box connection
pnpm, strict tsconfig, vitest, eslint/prettier, GH Actions skeleton, MIT, README stub (§1–2 positioning), `CLAUDE.md`. `commander` skeleton (all four subcommands stubbed). `config` (zod) + loader + `${ENV}`. `client/connect.ts` connects over **stdio**, runs `initialize`, prints version + `tools/list`.
**Acceptance:** `mcpward run` against real `@modelcontextprotocol/server-filesystem` connects, negotiates, lists tools; `mcpward init` writes a valid config.

### Phase 1 — Compliance + schema validation
`checks/compliance.ts`, `checks/schema.ts`, normalized result model, `report/console.ts` + `report/json.ts`, exit codes. Fixtures: `good-server`, `malformed-server`.
**Acceptance:** clean pass on reference servers; precise failures + exit `1` on `malformed-server`; negative tests prove each rule can fail.

### Phase 2 — Baseline snapshot + drift/rug-pull (moat #1)
`surface/capture.ts`, `surface/diff.ts` (classifier §7.2), `checks/drift.ts` (`fail_on`). Fixtures: `drift/v1`,`drift/v2` (one of each class incl. silent description edit).
**Acceptance:** classifier truth table 100% green; description change ⇒ `description_changed`; required-field add ⇒ breaking; optional-field add ⇒ non-breaking; `readOnlyHint` flip ⇒ `annotation_changed`; unchanged server ⇒ zero drift.

### Phase 3 — Security / tool-poisoning + SARIF (moat #3)
`checks/security.ts` + `report/sarif.ts` (§5.3). Fixture: `poisoned-server`.
**Acceptance:** each heuristic trips on `poisoned-server` with **zero** false positives on `good-server`; SARIF validates and renders in GitHub code scanning.

### Phase 4 — Behavioral + two-layer error contract (moat #2) + latency
`checks/behavioral.ts`, `assert/jsonpath.ts`, `assert/jsonschema.ts`, `checks/errors.ts` (§5.1), `checks/latency.ts`; optional golden snapshots. Fixtures: `slow-server` + error behaviors.
**Acceptance:** suites run; `protocol_error_code` vs `tool_is_error` asserted independently and both can fail; latency budget fails on `slow-server`, passes on `good-server`.

### Phase 5 — CI integration + HTTP parity + release
`report/junit.ts` polish; **Streamable HTTP** parity with stdio (+ bearer header); composite Action in `action/` + `examples/ci.yml`; dogfood in own CI + JUnit; README (positioning, quickstart, config reference, CI recipes, exit-code contract); `npm publish` (`npx mcpward`) via semantic-release + changelog.
**Acceptance:** JUnit renders in GH Actions; Action works in a clean repo; HTTP and stdio produce identical result models; `npx mcpward@latest run` works from a clean machine.

---

## 11. Project CI/CD
- `ci.yml`: install → lint → typecheck → `vitest run` (unit+fixture+negative+golden) across Node×OS. Required for merge.
- `integration.yml`: nightly + on release; pinned real servers.
- `release.yml`: on tag, build + `npm publish` (semantic-release) + changelog.
- Branch protection: no merge without green `ci.yml`.

---

## 12. Risks & de-risking
- **Incumbent expansion** (Inspector adds CI; `fastmcp` test helpers) → stay on black-box + rug-pull/tool-poisoning + CI-report ground they don't occupy.
- **Seed competitors** (mcpvet, MCP-Contract-CI) → lead with the security differentiators (§2); ship Phases 0–3 fast; open with a 20-second asciinema demo of a rug-pull + a poisoned tool getting caught in CI.
- **Protocol churn** → never hardcode versions; isolate protocol assumptions in `client/`.
- **False positives kill trust** → `good-server` stays 100% clean every phase; any false positive (esp. security) is a release blocker.

---

## 13. Definition of Done (MVP)
All 7 check families green against fixtures with negative tests · stdio+HTTP parity · console/JSON/JUnit/SARIF reporters + documented exit codes · `init`/`run`/`baseline`/`diff` functional · classifier matches §7.2 · CI matrix (Node×OS) + pinned real-server integration green · published to npm as `npx mcpward` · GitHub Action usable in a clean repo · README leads with the security+contract positioning.

---

## 14. Repo metadata (ready to paste)

**GitHub "About" / repo description:**
> Black-box security & contract testing for MCP servers. Catch rug-pulls, tool poisoning, schema drift & protocol violations in CI — with JUnit & SARIF reports.

**GitHub topics:**
`mcp` · `model-context-protocol` · `mcp-server` · `mcp-tools` · `ai-agents` · `llm` · `contract-testing` · `regression-testing` · `security` · `devsecops` · `sarif` · `json-rpc` · `schema-validation` · `ci` · `cli` · `testing` · `developer-tools`

**npm `description`:** `Black-box security & contract testing for MCP servers — rug-pull, tool-poisoning, schema-drift & protocol checks for CI (JUnit + SARIF).`

**npm `keywords`:** `["mcp","model-context-protocol","mcp-server","contract-testing","regression-testing","security","tool-poisoning","rug-pull","schema-validation","json-rpc","sarif","junit","ci","cli","ai-agents","llm","testing","devtools"]`

**README H1 tagline:** `mcpward — catch rug-pulls, tool poisoning, and schema drift in your MCP servers before your agents do.`

---

## 15. Handing this to Claude Code
1. Repo in, this file as `SPEC.md`, plus the provided `CLAUDE.md` (encodes the Prime Directive, moat, stack, classifier table, and testing principles — Claude Code reads it as project memory, preventing scope drift).
2. Work **phase by phase**; don't advance until the phase's fixtures + negative tests are green. Paste each phase's acceptance criteria as the definition of done.
3. Write fixtures **before** the check that consumes them.
4. Optional multi-agent QA (your seminar pattern): after Claude Code builds, have Codex independently verify every check family has a **negative** test and that `good-server` has zero findings.

## 16. Post-MVP (do not build yet)
Resource/prompt behavioral suites · exercising `sampling`/`elicitation` · pytest plugin · pre-commit hook · shareable/registry baselines · PR-comment bot posting classified drift · richer security rules · load/perf profiles.
