# CLAUDE.md — mcpward

> Working name: **mcpward** (swap here if you pick another; keep it consistent across package.json, README, CLI bin, and docs). Read `SPEC.md` for the full MVP plan; this file is the always-on guardrails.

## What we're building
A CLI-first, **black-box, framework-agnostic** harness that validates any running MCP server (stdio or Streamable HTTP) — leading with **security + contract testing**: protocol compliance, tool-schema validation, **rug-pull detection** (silently mutated tool descriptions/schemas between versions), the **two-layer error contract**, latency budgets, and **tool-poisoning heuristics**. Runs locally and in CI with deterministic reports (console / JSON / JUnit / SARIF) and meaningful exit codes.

## Prime Directive (never violate)
- This is **NOT** another visual inspector. `modelcontextprotocol/inspector` and `MCPJam/inspector` own interactive debugging; `fastmcp` owns in-process unit tests for servers you author. If a feature reads as "a nicer inspector UI," it's out of scope. Stay **headless, deterministic, CI-shaped**.
- We connect to servers as a **real MCP client via the official `@modelcontextprotocol/sdk`** — never a hand-rolled protocol reimplementation. This is the legitimacy backbone.
- **Black-box only:** we must be able to test servers we did NOT write, given just a command or a URL.

## Competitive moat — do NOT just rebuild what exists
Seed competitors already exist (all 0–2★, no traction), so copying them wins nothing:
- **mcpvet** (Python) already does: lint + snapshot/diff + `test --format junit` over stdio/HTTP. Do not stop at parity with this.
- **MCP-Contract-CI** (Node) already does: manifest diff + saved tool-call replay, breaking-changes only.

**Our wedge is the security + contract combination none of them cover.** Lead with and nail these first — they are the reason to exist:
1. **Rug-pull by description mutation** — detect when a tool's *description* silently changes between versions (competitors catch rename/type/drop, not this). Hash descriptions in the lockfile; flag `description_changed`.
2. **Two-layer error contract** — verify protocol errors (JSON-RPC `error` object) vs tool errors (successful result with `isError: true`) are used correctly. Nobody else checks this.
3. **Tool-poisoning heuristics + SARIF** — injection-like phrasing in descriptions, zero-width/hidden unicode, schemas soliciting secrets, `readOnlyHint`↔behavior mismatch. Emit SARIF so findings surface in GitHub code scanning. This is the traffic driver.

If asked to prioritize, prioritize the moat (1–3) over generic contract features.

## Stack (fixed)
TypeScript, Node ≥ 20 · official `@modelcontextprotocol/sdk` client · `ajv`+`ajv-formats` (JSON Schema) · `zod` (config) · `yaml` config + JSON lockfile · `execa` (stdio spawn) · `microdiff` or small custom differ · `commander` CLI · `picocolors` · `vitest` (our tests) · `eslint`+`prettier` · `pnpm` · **MIT** license · distribute as `npx`-runnable npm package.

## Check families
1. **Compliance** — `initialize` handshake, sane negotiated `protocolVersion` (read from SDK, never hardcode), capability↔reality consistency, valid JSON-RPC, `ping`.
2. **Schema** — valid `inputSchema`/`outputSchema`, unique names matching `^[a-zA-Z0-9_-]+$`, non-empty descriptions, well-formed annotations.
3. **Drift / rug-pull** — snapshot surface to lockfile; typed diff; classify (table below).
4. **Behavioral** — declarative suites: call tool → assert error/no-error, output-matches-schema, JSONPath; optional golden snapshots for deterministic tools.
5. **Error contract** — invalid params ⇒ correct protocol error code; tool failure ⇒ `isError: true`, NOT a protocol error.
6. **Latency** — p50/p95 across N samples vs budget.
7. **Security (moat)** — tool-poisoning heuristics → SARIF.

Every check emits the SAME normalized result object `{id, family, status, severity, message, expected, actual, location}`. Reporters only read that model. Exit codes: `0` pass · `1` check failed · `2` config/connection error.

## Drift classifier truth table (implement + fixture-test exactly)
| Change | Class | Default fail? |
|---|---|---|
| In lock, absent now | `tool_removed` | yes |
| Absent in lock, present now | `tool_added` | no |
| Description hash changed | `description_changed` (rug-pull) | yes |
| Added required field / removed field / narrowed type / tightened enum | `breaking_schema_change` | yes |
| Added optional field / widened type / loosened constraint | `nonbreaking_schema_change` | no |
| `readOnlyHint` true→false or `destructiveHint` false→true | `annotation_changed` | yes |
| `outputSchema` removed/narrowed | breaking; added/widened | non-breaking |

Encode this as a **pure function** with an exhaustive fixture-backed test.

## How we test THIS tool (mandatory — a test harness we can't trust is worthless)
- **Ground-truth fixture servers** (built with the official SDK) are the legitimacy engine: `good-server` (all pass, zero false positives), `malformed-server` (bad JSON-RPC/error codes/crashes), `drift/v1`→`drift/v2` (exactly one change per class), `slow-server` (over budget), `poisoned-server` (injection + hidden unicode + secret-soliciting schema).
- **Assert-it-can-fail:** every check MUST have a negative test feeding a known-bad fixture and asserting a failure with the right id/severity. A check that can't go red is a bug.
- **Unit-test pure logic** (diff/classifier, schema wrappers, JSONPath, config, exit codes) as truth tables. No coverage theater — target the classifier and error-layer logic.
- **Golden-snapshot** JSON + JUnit reports (locks the machine-readable contract).
- **Integration** against real, **version-pinned** reference servers (`server-filesystem`, `server-memory`, `server-everything`) via `npx` — separate suite, run on schedule/release.
- **Both transports** (stdio + HTTP) produce identical normalized results for equivalent servers.
- **CI matrix:** Node 20/22 × Linux+macOS. Gate merges on unit+fixture+negative+golden green.
- **Dogfood:** our CI runs `mcpward` against our own fixtures and publishes JUnit.

## Working conventions for you (the agent)
- Work **phase by phase** (SPEC.md §10). Do NOT advance until the phase's fixtures + negative tests are green. Paste each phase's acceptance criteria as the task's definition of done.
- Write the **fixture before** the check that consumes it, so the check is built against known ground truth.
- Keep protocol assumptions isolated in `src/client/`. Never hardcode a protocol version.
- **False positives are release blockers:** `good-server` stays 100% clean through every phase.
- No GUI, no hosted service, no OAuth beyond a static bearer token (see SPEC.md §3 out-of-scope).
- The JSON/JUnit/SARIF report shapes and exit codes are a **public contract** — version them, don't break silently.

## Repo metadata & publishing — apply these EXACTLY (do not improvise wording)

### In files (you write these)
**`package.json`** — set these fields verbatim:
```json
"description": "Black-box security & contract testing for MCP servers — rug-pull, tool-poisoning, schema-drift & protocol checks for CI (JUnit + SARIF).",
"keywords": ["mcp","model-context-protocol","mcp-server","contract-testing","regression-testing","security","tool-poisoning","rug-pull","schema-validation","json-rpc","sarif","junit","ci","cli","ai-agents","llm","testing","devtools"],
"bin": { "mcpward": "./dist/cli.js" },
"license": "MIT"
```
**`README.md`** — H1 tagline exactly:
`# mcpward — catch rug-pulls, tool poisoning, and schema drift in your MCP servers before your agents do.`
README must, in order: 1-line value prop → 20-second asciinema/GIF demo placeholder showing a rug-pull + a poisoned tool caught in CI → `npx mcpward` quickstart → the §2 "how we differ" table → config reference → CI recipe (GitHub Action) → documented exit codes (`0`/`1`/`2`). Lead with security+contract positioning, not "yet another inspector."

### On GitHub (NOT files — set via `gh` CLI if authenticated, else leave a TODO for the human)
These are repo settings, not committed files. If `gh` is available and authed, run:
```bash
gh repo edit --description "Black-box security & contract testing for MCP servers. Catch rug-pulls, tool poisoning, schema drift & protocol violations in CI — with JUnit & SARIF reports."
gh repo edit --add-topic mcp --add-topic model-context-protocol --add-topic mcp-server --add-topic mcp-tools \
  --add-topic ai-agents --add-topic llm --add-topic contract-testing --add-topic regression-testing \
  --add-topic security --add-topic devsecops --add-topic sarif --add-topic json-rpc \
  --add-topic schema-validation --add-topic ci --add-topic cli --add-topic testing --add-topic developer-tools
```
If `gh` is not available, do NOT guess — print these commands and a note that the human must set the About description + topics manually in the GitHub UI.

### npm publish (Phase 5)
Publish unscoped as `mcpward` so `npx mcpward` works. Confirm the name is still free at publish time (`npm view mcpward`); if taken, STOP and ask the human rather than renaming silently.

## Scope for v1 (Definition of Done)
All 7 check families green against fixtures with negative tests · stdio+HTTP parity · console/JSON/JUnit/SARIF reporters · `init`/`run`/`baseline`/`diff` working · classifier matches the table · CI matrix + pinned-real-server integration green · published to npm as `npx mcpward` · GitHub Action usable in a clean repo · README leads with the security+contract positioning.
