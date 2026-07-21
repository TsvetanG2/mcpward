# Security Policy

`mcpward` is a security testing tool, so we hold our own disclosure process to the standard we ask of others.

## Supported versions

| Version | Supported |
| ------- | --------- |
| `0.x`   | ✅ Latest minor only |

Until `1.0.0`, only the most recent released version receives security fixes. Upgrade before reporting.

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
