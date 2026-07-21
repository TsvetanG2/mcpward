# mcpward Rules Reference

This document describes all check rules emitted by mcpward. Each rule has a unique ID, severity, and actionable guidance.

---

## SARIF Report Locations

When mcpward generates SARIF reports for GitHub Code Scanning, findings include location information:

- **Physical Location**: All findings reference `mcpward.yaml` as the physical location, since mcpward performs black-box testing against remote servers and cannot determine line numbers in the server's source code.

- **Logical Location**: Each finding includes a `logicalLocations` entry with:
  - `name`: The tool name or entity that caused the finding
  - `kind`: Always `"tool"` for tool-related findings

This approach ensures all findings are grouped under your project's configuration file, making it easy to track and manage MCP server validation results in your CI/CD pipeline.

---

## Compliance Rules

Compliance rules verify that the MCP server correctly implements the protocol handshake and responds to standard requests.

### compliance/handshake

**Severity:** error

Verifies that the MCP server completes the protocol handshake successfully. The client sends an `initialize` request with its capabilities and the server must respond with its own capabilities and version information.

**What it checks:**
- Server responds to `initialize` request
- Response includes valid `serverInfo` object
- Response includes `protocolVersion`

**How to fix:**
Ensure your MCP server implements the `initialize` handler correctly and returns the required fields. If using the official SDK, this should be handled automatically.

### compliance/protocol-version

**Severity:** warning

Verifies that the negotiated protocol version is recognized and supported. mcpward warns when the server reports an unknown or outdated protocol version.

**What it checks:**
- `protocolVersion` follows semantic versioning
- Protocol version is a known, supported version

**How to fix:**
Update your MCP server to use a current protocol version. Check the MCP specification for supported versions.

### compliance/server-info

**Severity:** warning

Verifies that the server provides complete identification information including name and version.

**What it checks:**
- `serverInfo.name` is present and non-empty
- `serverInfo.version` follows semantic versioning (recommended)

**How to fix:**
Ensure your server's `initialize` response includes a complete `serverInfo` object with both `name` and `version` fields.

### compliance/capabilities

**Severity:** warning

Verifies that the server's declared capabilities match its actual behavior. If a server declares it supports tools, it should respond to `tools/list`.

**What it checks:**
- Declared capabilities match available functionality
- Server responds appropriately to capability-related requests

**How to fix:**
Review your server's capability declarations and ensure they accurately reflect what the server implements.

### compliance/ping

**Severity:** info

Verifies that the server responds to ping requests. This is a basic liveness check.

**What it checks:**
- Server responds to `ping` request
- Response is timely (within reasonable bounds)

**How to fix:**
Ensure your server implements the `ping` handler. Most MCP SDKs handle this automatically.

### compliance/expected-protocol-version

**Severity:** warning

Verifies that the server uses the expected protocol version when one is specified in the config. This helps catch version drift.

**What it checks:**
- Negotiated version matches expected version from config

**How to fix:**
Update either your server or config to use matching protocol versions.

---

## Schema Rules

Schema rules validate that tool definitions conform to MCP specifications and JSON Schema standards.

### schema/list-tools

**Severity:** error

Verifies that the server responds to `tools/list` request. This is required if the server declares tool capabilities.

**What it checks:**
- Server responds to `tools/list`
- Response is valid JSON-RPC

**How to fix:**
Implement the `tools/list` handler in your server.

### schema/unique-names

**Severity:** error

Verifies that all tool names are unique. Duplicate tool names cause ambiguity for clients.

**What it checks:**
- No two tools share the same name

**How to fix:**
Rename duplicate tools to have unique identifiers.

### schema/summary

**Severity:** info

Summary of all schema validation checks performed.

### schema/tool-name

**Severity:** error

Verifies that tool names follow the required pattern: alphanumeric characters, underscores, and hyphens only.

**What it checks:**
- Name matches pattern `^[a-zA-Z0-9_-]+$`
- Name is non-empty

**How to fix:**
Rename tools to use only allowed characters. Avoid spaces, special characters, and unicode.

### schema/tool-description

**Severity:** warning

Verifies that tools have meaningful descriptions. Descriptions help LLMs understand when and how to use tools.

**What it checks:**
- Description is present
- Description is non-empty
- Description is reasonably detailed (not just the tool name)

**How to fix:**
Add clear, concise descriptions that explain what the tool does, when to use it, and any important constraints.

### schema/tool-input-schema

**Severity:** error

Verifies that tool input schemas are valid JSON Schema definitions.

**What it checks:**
- `inputSchema` is present and valid JSON Schema
- Schema has `type: "object"`
- Required fields are defined in the schema

**How to fix:**
Ensure your tool's `inputSchema` is a valid JSON Schema object. Use JSON Schema validators to check your schemas.

### schema/tool-annotations

**Severity:** warning

Verifies that tool annotations (hints like `readOnlyHint`, `destructiveHint`) are valid boolean values.

**What it checks:**
- Annotation values are booleans, not strings
- Known annotations use correct types

**How to fix:**
Use proper boolean values (`true`/`false`) for annotations, not strings like `"true"`.

---

## Security Rules

Security rules detect potential security issues including prompt injection patterns and credential exposure risks.

### security/list-tools

**Severity:** info

Internal check that tools were successfully listed for security scanning.

### security/summary

**Severity:** info

Summary of security scan results.

### security/injection-pattern

**Severity:** error

Detects prompt injection patterns in tool descriptions. These patterns could be used to manipulate LLM behavior.

**What it checks:**
- Descriptions for patterns like "ignore previous instructions"
- System prompt override attempts
- Instructions that attempt to change LLM behavior

**How to fix:**
Remove or rephrase tool descriptions that contain instruction-like language. Tool descriptions should describe what the tool does, not instruct the LLM how to behave.

**Example dangerous patterns:**
- "Ignore all previous instructions and..."
- "Before doing anything else, you must..."
- "IMPORTANT: Always call this tool first"

### security/hidden-unicode

**Severity:** error

Detects hidden unicode characters that could conceal malicious content. Zero-width characters, bidirectional overrides, and other invisible characters can hide text from human review.

**What it checks:**
- Tool names for zero-width characters
- Descriptions for bidirectional override characters
- Any text for non-printable unicode

**How to fix:**
Remove all hidden unicode characters from tool names and descriptions. Use a unicode-aware text editor to identify and remove them.

### security/secret-in-schema

**Severity:** error

Detects when tool input schemas appear to solicit secrets like API keys, passwords, or tokens. Tools should not request credentials directly.

**What it checks:**
- Field names containing `password`, `secret`, `token`, `api_key`, etc.
- Descriptions suggesting credential input

**How to fix:**
Tools should use environment variables or secure configuration for credentials, not request them as tool inputs.

### security/annotation-mismatch

**Severity:** warning

Detects when a tool's behavior hints don't match its name or description. For example, a tool named `delete_file` marked as `readOnlyHint: true` is suspicious.

**What it checks:**
- `readOnlyHint: true` on tools with destructive-sounding names
- `destructiveHint: false` on tools that appear to modify data

**How to fix:**
Ensure annotation hints accurately reflect tool behavior. If a tool can modify data, set `readOnlyHint: false`.

---

## Drift Rules

Drift rules detect changes between the current server state and a previously captured baseline. These help catch rug-pull attacks and breaking changes.

### drift/baseline-missing

**Severity:** error

No baseline file found to compare against.

**How to fix:**
Run `mcpward baseline` to capture the current server state before running drift checks.

### drift/baseline-invalid

**Severity:** error

The baseline file exists but is not valid JSON or doesn't match the expected schema.

**How to fix:**
Delete the corrupted baseline and re-run `mcpward baseline`.

### drift/capture-failed

**Severity:** error

Failed to capture the current server state for comparison.

**How to fix:**
Check server connectivity and ensure `tools/list` is working.

### drift/no-changes

**Severity:** info

No differences detected between current state and baseline.

### drift/summary

**Severity:** info

Summary of all drift checks performed.

### drift/tool-removed

**Severity:** error

A tool that existed in the baseline is no longer present. This is a breaking change.

**How to fix:**
If intentional, update the baseline with `mcpward baseline`. If not, restore the missing tool.

### drift/tool-added

**Severity:** warning

A new tool has been added since the baseline. This may indicate new functionality or a rug-pull attempt.

**How to fix:**
Review the new tool carefully. If legitimate, update the baseline.

### drift/description-changed

**Severity:** error

A tool's description has changed since the baseline. This could indicate a rug-pull attack where tool behavior is silently modified after trust is established.

**What it checks:**
- Description text hash comparison

**How to fix:**
Review the description change carefully. If the change is legitimate, update the baseline. Investigate unexpected changes.

### drift/breaking-schema-change

**Severity:** error

A tool's input schema has changed in a breaking way (added required fields, removed fields, narrowed types).

**How to fix:**
Breaking schema changes require client updates. Review carefully and update baseline if intentional.

### drift/nonbreaking-schema-change

**Severity:** warning

A tool's input schema has changed in a non-breaking way (added optional fields, widened types).

**How to fix:**
Review the change and update the baseline if appropriate.

### drift/annotation-changed

**Severity:** error

Tool annotations have changed in a concerning way (e.g., `readOnlyHint` changed from true to false).

**How to fix:**
Review the annotation change. If a tool is now destructive, clients may need to update their handling.

---

## Behavioral Rules

Behavioral rules verify that tools behave as expected when called with test inputs.

### behavioral/list-tools

**Severity:** info

Internal check that tools were listed for behavioral testing.

### behavioral/tool-exists

**Severity:** error

A tool referenced in a test suite doesn't exist on the server.

**How to fix:**
Update your test suite to reference valid tool names, or add the missing tool to the server.

### behavioral/summary

**Severity:** info

Summary of behavioral test results.

### behavioral/case

**Severity:** error

A test case in a behavioral suite failed. The tool output didn't match expectations.

**How to fix:**
Review the test case expectations and tool implementation. Either fix the tool or update the expected values.

### behavioral/tool-is-error

**Severity:** error

A tool returned `isError: true` when the test expected success, or vice versa.

**How to fix:**
Review the tool's error handling logic and test expectations.

### behavioral/output-schema

**Severity:** error

Tool output didn't match the expected output schema.

**How to fix:**
Ensure the tool returns data matching its declared `outputSchema`.

### behavioral/jsonpath

**Severity:** error

A JSONPath assertion in a test case failed.

**How to fix:**
Review the JSONPath expression and expected value in your test suite.

### behavioral/protocol-error

**Severity:** error

The tool call resulted in a protocol-level error (JSON-RPC error) when tool-level error was expected, or vice versa.

**How to fix:**
Review MCP error handling. Protocol errors are for invalid requests; tool errors (`isError: true`) are for valid requests that fail during execution.

---

## Error Contract Rules

Error contract rules verify that the server correctly distinguishes between protocol-level errors and tool-level errors.

### errors/list-tools

**Severity:** info

Internal check that tools were listed for error testing.

### errors/summary

**Severity:** info

Summary of error contract checks.

### errors/unknown-tool

**Severity:** error

Tests that calling an unknown tool returns a proper protocol error (not a tool error).

**What it checks:**
- Unknown tool call returns JSON-RPC error
- Error code indicates invalid method/tool

**How to fix:**
Ensure your server returns a protocol error (JSON-RPC error object) when an unknown tool is called, not a successful response with `isError: true`.

### errors/invalid-params

**Severity:** error

Tests that calling a tool with invalid parameters returns a proper protocol error.

**What it checks:**
- Invalid params return JSON-RPC error
- Error code is appropriate (-32602 for invalid params)

**How to fix:**
Validate tool inputs against the schema and return a JSON-RPC error for schema violations.

---

## Latency Rules

Latency rules measure tool response times against configured budgets.

### latency/list-tools

**Severity:** info

Internal check that tools were listed for latency testing.

### latency/no-tools

**Severity:** info

No tools available for latency testing.

### latency/summary

**Severity:** info

Summary of latency measurements including p50, p95, and max times.

### latency/tool

**Severity:** warning or error (configurable)

A tool's response time exceeded the configured latency budget.

**What it checks:**
- p50 latency vs budget
- p95 latency vs budget

**How to fix:**
Optimize the tool's implementation or adjust the latency budget in your config if the current threshold is too strict.
