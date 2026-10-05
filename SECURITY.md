# Security Policy

`mcpward` is a security testing tool, so we hold our own disclosure process to the standard we ask of others.

## Supported versions

| Version | Supported |
| ------- | --------- |
| `1.x`   | ✅ Latest minor |
| `0.x`   | ❌ Upgrade to 1.x |

Security fixes are released for the latest `1.x` minor. Within 1.x, upgrades never break the public contract ([`docs/stability.md`](docs/stability.md)), so staying current is safe. Upgrade before reporting.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately via [GitHub Security Advisories](https://github.com/TsvetanG2/mcpward/security/advisories/new). This creates a private channel visible only to maintainers.

Please include:

- Affected version and platform (OS, Node version)
- A minimal reproduction — ideally a fixture MCP server or config that triggers it
- Impact assessment: what an attacker gains
- Any suggested remediation

### What to expect

| Stage | Target |
| ----- | ------ |
| Acknowledgement | within 72 hours |
| Initial assessment | within 7 days |
| Fix or mitigation plan | within 30 days for confirmed high severity |

We will credit reporters in the advisory and `CHANGELOG.md` unless you prefer to stay anonymous.

## Scope

### In scope

- **False negatives in security checks** — a genuinely poisoned or drifted server that `mcpward` reports as clean. This is the most serious class of bug in this project: silent failure defeats the tool's entire purpose.
- Code execution, path traversal, or privilege escalation triggered by a malicious server response, config file, or lockfile.
- Secret leakage — credentials from `${ENV}` interpolation, headers, or server env appearing in reports, logs, or SARIF output.
- Denial of service in the harness caused by a hostile server (unbounded memory, hangs without timeout).
- Supply-chain issues in published artifacts.

### Out of scope

- Vulnerabilities in the MCP servers you point `mcpward` at — report those to their maintainers. `mcpward` is the messenger.
- Findings from `mcpward` itself run against third-party servers; those are the server's problem, not ours.
- False positives (annoying, and we want to fix them — but file a normal issue).
- Missing detection for a novel attack technique we have never claimed to cover. Open a feature request; we will happily add heuristics.
- Issues requiring an already-compromised local machine or a maliciously modified `mcpward` install.

## Threat model

`mcpward` connects to **untrusted** MCP servers by design. It spawns subprocesses (stdio transport) and makes HTTP requests using configuration the user supplies. It assumes:

- The **config file and lockfile are trusted** — they come from the user's repo.
- The **server under test is untrusted** — all of its responses, tool descriptions, and schemas are treated as hostile input and must never be executed, evaluated, or blindly interpolated.

Anything that breaks the second assumption is a valid vulnerability report.

### Tool calls

Most checks only read `tools/list`. The error-contract checks, latency measurement, behavioral suites and output drift **call tools** on the server under test. Since 1.1.0, latency and output drift call only tools annotated `readOnlyHint: true` (and not `destructiveHint: true`) unless you allowlist others — or, for latency, set `checks.latency.call_all: true`, which calls every tool, destructive ones included; the error-contract checks call tools with empty arguments, which a server that validates input rejects, and can be turned off with `checks.errors: false`. The README section [*Which checks call tools*](README.md#which-checks-call-tools) lists exactly what each check calls. A check that calls a tool the documented policy forbids is a valid vulnerability report.

### Environment of a stdio server

A stdio server is a subprocess, and it **inherits mcpward's environment** — except mcpward's own credentials (`MCPWARD_GITHUB_TOKEN`, `GITHUB_TOKEN`), which are always withheld. Values in the config's `server.env` are passed explicitly. This keeps servers that read their settings from the environment working without extra configuration.

The consequence: any secret in the environment where mcpward runs is visible to the server under test. When testing a server you do not trust, **do not put unrelated secrets in that job's environment** — scope them to the steps that need them, and pass the server only what it needs through `server.env`.

## Supply chain

### Advisories in dependencies

mcpward pins no transitive dependency: `npm install` / `npx` resolve the newest versions its ranges allow, so a patched release of a transitive dependency reaches users without a new mcpward release. Our own lockfile is kept free of known advisories (`pnpm audit --prod`), and Dependabot opens updates weekly.

Most advisories reported against the installed tree concern the HTTP *server* stack that `@modelcontextprotocol/sdk` ships (`hono`, `express`, `qs`). mcpward is an MCP *client*: it never starts an HTTP server, so those code paths are not executed.

### Why supply-chain scanners flag this package

| Alert | Cause | Assessment |
|---|---|---|
| Obfuscated code | `qs/dist/qs.js` — a minified UMD browser bundle of a ubiquitous query-string library, pulled in via `express` | Minified, not obfuscated. Not our code and not executed by the CLI. |
| Uses eval | `ajv` compiles JSON Schemas into validator functions at runtime | This is how ajv works by design. We use it for schema validation. |
| Shell access | `cross-spawn` (via `@modelcontextprotocol/sdk`) | Required: the stdio transport spawns MCP servers as subprocesses. This is the tool's core function. |
| Network access | HTTP transport and the eventsource stack | Required for testing servers over Streamable HTTP. |
| Environment variable access | `${ENV}` interpolation in config | Intentional, and interpolated secrets are redacted from all reports — see `src/report/redact.ts`. |

### Dependency posture

mcpward declares **7 direct runtime dependencies**, but the installed tree is ~95 packages because `@modelcontextprotocol/sdk` bundles its server-side HTTP stack (`express`, `hono`, `cors`) even for client-only use. Reducing this footprint is tracked as a future improvement. We do not add runtime dependencies casually.
