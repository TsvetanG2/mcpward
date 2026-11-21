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

Detects prompt injection patterns in text the model reads. These patterns could be used to manipulate LLM behavior.

**Where it looks:** every text of a tool the model reads: the tool description, its `title` and `annotations.title`, and everywhere in the input schema — the root and its `anyOf`/`oneOf`/`allOf`/`not` branches, every parameter at any depth, and every `$defs`/`definitions` entry whether referenced or not. In each place it reads `description`, `title`, `$comment`, `enumDescriptions` and every string (object keys too) in `default`, `examples`, `example` and `x-*` values. Since 1.3.1; before, only tool and parameter descriptions were read. `enum` and `const` values are data and are not read.

**Location:** the full path — `tool` (description), `tool.title`, `tool.annotations.title`, `tool.inputSchema.<keyword>` (schema root), `tool.<param path>` (parameter description), `tool.<param path>.<keyword>` (anything else), with `$defs/Name` or `definitions/Name` in the path of a definition. Several strings under one keyword are one finding.

**What it checks:**

- Patterns like "ignore previous instructions"
- System prompt override attempts
- Instructions that attempt to change LLM behavior

**How to fix:**
Remove or rephrase text that contains instruction-like language. Descriptions, titles, defaults and examples should describe what the tool does, not instruct the LLM how to behave.

**Example dangerous patterns:**

- "Ignore all previous instructions and..."
- "Before doing anything else, you must..."
- "IMPORTANT: Always call this tool first"

### security/hidden-unicode

**Severity:** error

Detects hidden unicode characters that could conceal malicious content from a human reviewer while the model still reads it.

**What it checks:**

- The tool name, and the same text as [`security/injection-pattern`](#securityinjection-pattern), with the same locations: every text of a tool the model reads: the tool description, its `title` and `annotations.title`, and everywhere in the input schema — the root and its `anyOf`/`oneOf`/`allOf`/`not` branches, every parameter at any depth, and every `$defs`/`definitions` entry whether referenced or not. In each place it reads `description`, `title`, `$comment`, `enumDescriptions` and every string (object keys too) in `default`, `examples`, `example` and `x-*` values. Since 1.3.1; before, only tool and parameter descriptions were read.
- Zero-width characters (e.g. U+200B, U+200D, U+FEFF)
- Bidirectional overrides and isolates (U+202A–U+202E, U+2066–U+2069)
- **Unicode Tag characters** (U+E0000–U+E007F, "ASCII smuggling"): invisible characters that map 1:1 onto ASCII. The finding decodes the hidden text so you can read it. Valid subdivision flags (U+1F3F4 + an ISO 3166-2 code such as `gbsct` + U+E007F, e.g. the Scotland flag) are not flagged; anything else wrapped between U+1F3F4 and U+E007F is.
- Confusable spaces (non-breaking and typographic spaces)

**How to fix:**
Remove all hidden unicode characters from tool names and the text reported. Use a unicode-aware text editor to identify and remove them.

### security/secret-in-schema

**Severity:** error

Detects when tool input schemas appear to solicit secrets like API keys, passwords, or tokens. Tools should not request credentials directly.

**What it checks:**

- Field names containing `password`, `secret`, `token`, `api_key`, etc., at any nesting depth — nested properties, array items, `additionalProperties` and `anyOf`/`oneOf`/`allOf` branches, and local `$ref` targets (JSON pointers and plain-name anchors, resolved in the schema resource — nearest `$id` — they belong to; remote references are never fetched). The message lists full paths (`options.password`, `accounts[].token`).
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

### How drift findings are classified

Every change gets a **drift class** (what changed) and a **severity** (blast radius). They are separate axes: a removed tool is _breaking_ but _low_ severity, because it fails loudly and gets fixed in minutes; a `readOnlyHint` flip is _high_ severity, because it silently changes what clients auto-approve.

| Class                             | Default severity                         | In default `fail_on`                             |
| --------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| `description_changed`             | high                                     | yes                                              |
| `annotation_changed`              | high                                     | yes                                              |
| `breaking_schema_change`          | medium                                   | yes                                              |
| `breaking_output_shape_change`    | medium                                   | yes (only produced when output drift is enabled) |
| `input_property_added`            | medium (high if the field looks hostile) | no                                               |
| `annotation_relaxed`              | medium                                   | no                                               |
| `idempotency_changed`             | medium                                   | no                                               |
| `tool_removed`                    | low                                      | yes                                              |
| `tool_added`                      | low                                      | no                                               |
| `nonbreaking_schema_change`       | low                                      | no                                               |
| `nonbreaking_output_shape_change` | low                                      | no                                               |

`checks.drift.fail_on` takes either a list of classes (above) or a severity threshold (`high` / `medium` / `low`). `checks.drift.severity` overrides the default severity per class, e.g. `severity: { tool_removed: high }`.

`input_property_added` was part of `nonbreaking_schema_change` before 1.2.0, so config written for the older class keeps its meaning: a `fail_on` list that names `nonbreaking_schema_change` also fails on `input_property_added`, and a `severity` override for `nonbreaking_schema_change` also applies to it — unless `input_property_added` has its own override, which wins.

Reporting level follows severity: high → error, medium → warning, low → info. A change that matches `fail_on` is always reported as a failure.

### drift/baseline-missing

**Severity:** warning (skipped)

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

**Severity:** info / error

Summary of all drift checks performed. Fails when at least one change matches `fail_on`.

### drift/auth-context-mismatch

**Severity:** warning

The baseline was captured with different credentials than the current run (credential fingerprints differ). Tools visible to one role may be hidden from another, so the drift below this warning may be an artifact of comparing mismatched surfaces rather than a real change.

**How to fix:**
Capture the baseline and run the comparison with the same credentials, or keep one baseline per auth role.

### drift/titles-not-compared

**Severity:** warning

The baseline was written before mcpward 1.3.0, which started capturing each tool's `title` and `annotations.title`. Titles cannot be compared against it, so a changed title would pass unnoticed. Everything else is still compared.

**How to fix:**
Re-run `mcpward baseline` (after reviewing that the current surface is the one you trust).

### drift/tool_removed

**Severity:** low (info) — fails under the default `fail_on`

A tool that existed in the baseline is no longer present. Clients calling it will break loudly at the call site.

**How to fix:**
If intentional, update the baseline with `mcpward baseline`. If not, restore the missing tool.

### drift/tool_added

**Severity:** low (info)

A new tool has been added since the baseline. Review it before your agents start using it — a new tool is new authority.

**How to fix:**
Review the new tool carefully. If legitimate, update the baseline.

### drift/description_changed

**Severity:** high (error)

A tool's description has changed since the baseline. The model reads descriptions to decide what to call and how, so a silent description change is the classic **rug-pull** vector: behavior is steered after trust is established.

This also fires for every other piece of text the model reads, when it is changed, added where there was none, or removed:

- the tool's top-level `title` and `annotations.title` (some clients show them to the model; compared since 1.3.0 — a baseline written by an older version has no titles, and a [`drift/titles-not-compared`](#drifttitles-not-compared) warning says they were not compared);
- `description` and `title` anywhere in the schema, the root included;
- `default`, `examples`, `$comment` and `x-*` extension values, and the common non-standard `example` (OpenAPI) and `enumDescriptions`, anywhere in the schema, the root included (since 1.3.0). These are compared as data, not prose: exactly, except that strings are Unicode NFC-normalized like every string in the schema.

Formatting-only edits to descriptions and titles (whitespace, line endings, Unicode normalization) are not drift. A `title` or `description` that is not a string is compared exactly.

**Exceptions:**

- **Text inside keywords the walk does not model** — `anyOf`, `oneOf`, `allOf`, `patternProperties`, `propertyNames`, `prefixItems`, `contains`, `dependentSchemas`, `dependencies`, `if`/`then`/`else`, `not`, `unevaluatedProperties` — is reported as [`breaking_schema_change`](#driftbreaking_schema_change) (high when it brings in hostile text), not as `description_changed`. It still fails CI by default.
- **Text that arrives with new structure** — a new optional field, a subschema that was `false` or `true`, `additionalProperties` that were closed, a new `items` schema, a new `$defs`/`definitions` entry — is reported with the structural finding, like [`input_property_added`](#driftinput_property_added): the whole new structure is read at every depth (definitions inside it included) and the finding is escalated to high when any of its text has injection-like phrasing or hidden unicode, or a field name solicits a secret.

**Expect churn from generated values.** A `default`, `examples` or `x-*` value that changes on every release (a version stamp, a build date, a generated id) is `description_changed` (high) each time. Review it and re-baseline. Lowering `description_changed` in `checks.drift.severity` would hide real rug-pulls too, so it is not a fix for this.

**What it checks:**

- SHA-256 of the canonicalized description (formatting-only changes such as line endings, NFC/NFD, or whitespace do not count; injected zero-width or bidi characters do)
- Console, Markdown and JSON reports show a word-level before/after diff with invisible characters marked as `<U+XXXX>`

**How to fix:**
Review the description change carefully. If the change is legitimate, update the baseline. Investigate unexpected changes.

### drift/breaking_schema_change

**Severity:** medium (warning); high (error) when a change the walk cannot classify (`allOf`, `if`/`then`, `$ref`, …) brings in an input field that looks hostile — the same test as [`input_property_added`](#driftinput_property_added)

A tool's input or output schema changed in a way that can reject previously valid calls, at any nesting depth (paths like `filter.status`, `rows[].id`):

- required property added, property removed, optional → required
- type narrowed or changed to an unrelated type
- `enum` value removed, or an `enum` added where there was none
- `minimum`/`minLength`/`minItems`/`minProperties` raised or added; `maximum`/`maxLength`/`maxItems`/`maxProperties` lowered or added
- `pattern`, `format`, `const` or `multipleOf` added or changed (a changed pattern cannot be proven compatible, so it is classified as breaking and the message says so)
- `uniqueItems` turned on, `additionalProperties` closed, an `items` constraint added
- `anyOf`/`oneOf`/`allOf` changed (cannot be classified structurally — conservative)
- any other keyword added, changed or removed — `prefixItems`, `contains`, `not`, `if`/`then`/`else`, `dependentRequired`, `propertyNames`, `unevaluatedProperties`, `$ref`, `$schema` and the like. These are not modelled, so compatibility cannot be determined and the message says so (even a removal can reject more: dropping `prefixItems` next to `items: false`). Text the model reads (`title`, `description`, `default`, `examples`, `example`, `enumDescriptions`, `$comment`, `x-*`) is reported as [`description_changed`](#driftdescription_changed) instead, and the `deprecated`/`readOnly`/`writeOnly` flags as `nonbreaking_schema_change`.
- `additionalItems` tightened behind a tuple (path `t[1+]`)
- a definition in `$defs`/`definitions` removed, or changed in any of the ways above (paths like `$defs/Item.x`) — a `$ref` target changes there, not at the `$ref`. A definition used under `not`, `if`, `oneOf` or a `contains` limited by `maxContains` (directly, through a pointer into it, through a plain-name anchor declared on or inside it, or through another definition) can reject more when it accepts more, so any change inside it is breaking.
- a declared schema removed

**How to fix:**
Breaking schema changes require client updates. Review carefully and update the baseline if intentional.

### drift/nonbreaking_schema_change

**Severity:** low (info) by default. Since 1.3.0:

- **medium** for a new `$defs`/`definitions` entry in an `inputSchema`. The model reads a definition's text whether or not anything refers to it, so it is treated like a new input field ([`input_property_added`](#driftinput_property_added)), with its description quoted in the message.
- **high** when the change brings in hostile input: a new definition, a subschema that was `false` or `true`, or `additionalProperties` that were closed, whose text anywhere inside has injection-like phrasing or hidden unicode, or whose field name solicits a secret.

In an `outputSchema` it always stays low: the server, not the model, fills in output.

A tool's schema changed compatibly, at any nesting depth: type widened, required → optional, `enum` value added or `enum` removed, bounds relaxed or removed, `pattern`/`format`/`const`/`multipleOf` removed, `uniqueItems` turned off, `additionalProperties` opened, `items` constraint removed, a `$defs`/`definitions` entry added, or a declared schema added.

Since 1.3.0 it also covers the `deprecated`, `readOnly` and `writeOnly` flags changing at any level: the model reads them, but they do not change which values are accepted.

An optional property added to an `inputSchema` is [`input_property_added`](#driftinput_property_added) since 1.2.0; one added to an `outputSchema` stays here.

**How to fix:**
Review the change and update the baseline if appropriate.

### drift/input_property_added

**Severity:** medium (warning); high (error) when the field looks hostile

An existing tool's `inputSchema` gained an optional property, at any nesting depth (`context`, `filter.since`, `rows[].note`). Existing calls keep working, so it is not breaking — but it is the post-approval exfiltration shape: a tool you already approved gains a field like `context` ("Extra context that helps the tool answer better"), and a helpful agent fills it with local file contents. The tool description does not have to change at all. The message quotes the new field's description, which nothing else diffs because there is no previous one.

Escalated to **high** when the new field, or anything nested in it, has a secret-soliciting name (the [`security/secret-in-schema`](#securitysecret-in-schema) patterns) or text with injection-like phrasing or hidden unicode — a description, and since 1.3.0 also a `title`, `$comment`, or any string in `default`, `examples` or an `x-*` value (the [`security/injection-pattern`](#securityinjection-pattern) and [`security/hidden-unicode`](#securityhidden-unicode) heuristics).

Not produced for a new tool (`tool_added`), a schema that did not exist before (`nonbreaking_schema_change`), or a new **required** property (`breaking_schema_change`).

**How to fix:**
Check what the new field asks the model to send. If that is expected, update the baseline. To fail CI on every new input field, use `fail_on: medium` or add `input_property_added` to a `fail_on` list.

### drift/annotation_changed

**Severity:** high (error)

A tool's annotations widened its authority. One finding per hint that now claims a riskier tool:

| Hint              | Riskier direction | Severity |
| ----------------- | ----------------- | -------- |
| `readOnlyHint`    | true → false      | high     |
| `destructiveHint` | false → true      | high     |
| `openWorldHint`   | false → true      | high     |

Clients use these hints to decide what to auto-approve. Values are compared as the MCP spec reads them: an absent hint counts as its default (`readOnlyHint` false, `destructiveHint` true, `openWorldHint` true), so a server that **removes** `readOnlyHint: true` or `destructiveHint: false` widens its authority just like one that flips it. `destructiveHint` only applies to tools that are not read-only, so it is not compared while `readOnlyHint` is true on either side: a tool that becomes read-only and drops `destructiveHint: false` is reported once, as `annotation_relaxed`. `idempotentHint` has its own class, `drift/idempotency_changed`.

**How to fix:**
Review the annotation change. If a tool is now destructive or reaches external systems, clients may need to update their handling.

### drift/annotation_relaxed

**Severity:** medium (warning)

A tool's annotations now claim a safer tool: `readOnlyHint` false → true, `destructiveHint` true → false or `openWorldHint` true → false, with absent hints read as their defaults (see `drift/annotation_changed`). Not breaking, but "I am harmless now" is exactly what clients auto-approve, so a tool that claims it after you reviewed it deserves a look. A server that adds annotations for the first time gets these warnings for every hint that is safer than its default. Not in the default `fail_on`.

**How to fix:**
Check that the tool really changed its behavior. If the claim is right, re-baseline. To fail CI on it, use `fail_on: medium` or add `annotation_relaxed` to a `fail_on` list.

### drift/idempotency_changed

**Severity:** medium (warning)

A tool's `idempotentHint` changed, in either direction. An absent hint counts as false, its MCP default. true → false means a retried call may now repeat its effects; false → true means the tool now claims retries are harmless, which a client may use to retry automatically. Losing or gaining idempotency is a risk for retries, not for data, so it has its own non-breaking class instead of `annotation_changed`. Like `destructiveHint`, it is not compared while `readOnlyHint` is true on either side. Not in the default `fail_on`.

**How to fix:**
Check that the tool's retry behavior really changed. If it did, re-baseline. To fail CI on it, use `fail_on: medium` or add `idempotency_changed` to a `fail_on` list.

### drift/breaking_output_shape_change

**Severity:** medium (warning)

The structure of a tool's **output**, inferred from real calls, changed in a way that breaks consumers: an always-present field disappeared or became optional, a field started returning a type the baseline never produced (e.g. `object` → `string`, or newly `null`), or the output format changed (structured content ↔ text).

Output drift is opt-in (`checks.drift.output.enabled`) because it **calls tools**. It only calls tools annotated `readOnlyHint: true` that take no required arguments, or tools you list explicitly in `checks.drift.output.tools` with arguments. Shapes are merged across `shape_samples` calls; only structure is compared, never values. Each finding records the sample counts.

**How to fix:**
Restore the output field/type, or update the baseline if the change is intentional and consumers have been updated.

### drift/nonbreaking_output_shape_change

**Severity:** low (info)

The inferred output structure changed compatibly: a field was added, an optional field was not observed, or a field stopped returning one of its types.

**How to fix:**
Usually nothing; update the baseline to record the new shape.

### drift/output-sampling

**Severity:** info (skipped) / warning (failed)

Explains why a tool's output shape was not sampled: refused (no `readOnlyHint: true` and not allowlisted — mcpward never calls a tool that may have side effects), skipped (requires arguments), failed (every call errored or outputs were inconsistent), or partial (some samples failed).

**How to fix:**
To sample a tool, add it to `checks.drift.output.tools` with the arguments to call it with.

---

## Collision Rules

The collision lint runs on a single surface — no baseline needed — so it works on first contact with a server you did not write.

### collision/list-tools

**Severity:** error

The tool list could not be retrieved, so the collision lint could not run.

### collision/summary

**Severity:** info / warning

Summary of the collision lint, or a notice that it was skipped because the server exposes more than `checks.collision.max_tools` tools (pairwise comparison is O(n²)).

### collision/description-collision

**Severity:** warning (error with `checks.collision.fail: true`)

Two tools have near-identical descriptions but accept materially different payloads. An agent that selects tools by description — increasingly via retrieval or embeddings — picks one confidently and wrong, and no success/error check can see it.

A pair is flagged only when **both** hold:

1. Description similarity (character-trigram Dice, offline, no model calls) is at or above `checks.collision.threshold` (default 0.8), **and**
2. The input schemas diverge: the _types_ of required parameters differ, or the maximum nesting depth differs.

Similarity alone is not enough on purpose: `list_users` / `list_projects`, or `get_user(user_id)` / `get_project(project_id)`, are legitimate tool families and stay silent.

**How to fix:**
Make each description say what distinguishes the tool — especially what it takes ("…by a structured filter object" vs "…by a single status string") — or merge the tools.

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

### behavioral/golden

**Severity:** error

A test case's output no longer matches its golden snapshot (`expect.golden`), or the golden file is missing or not valid JSON.

**What it checks:**

- The tool result's `content`, `structuredContent` and `isError`, compared with key order ignored
- The golden path resolves relative to the config file
- A missing golden file fails — it is never created implicitly, because a first CI run that writes its own expectation tests nothing

**How to fix:**
If the change is intended, re-run with `mcpward run --update-golden` and commit the updated file. Use golden snapshots only for deterministic tools (no timestamps or random values in the output).

### behavioral/protocol-error

**Severity:** error

The tool call resulted in a protocol-level error (JSON-RPC error) when tool-level error was expected, or vice versa.

**How to fix:**
Review MCP error handling. Protocol errors are for invalid requests; tool errors (`isError: true`) are for valid requests that fail during execution.

---

## Error Contract Rules

Error contract rules verify that the server correctly distinguishes between protocol-level errors and tool-level errors.

These checks **call tools**: a non-existent tool name, and every tool that has required parameters, with empty arguments. A server that validates its inputs rejects these calls before doing anything. They run on every `mcpward run`; turn them off with `checks.errors: false`.

### errors/list-tools

**Severity:** error

Tools could not be listed, so the error contract was not tested.

### errors/summary

**Severity:** error when a violation was found, info otherwise

Number of error-contract violations.

### errors/unknown-tool

**Severity:** error

Tests that calling an unknown tool returns a proper protocol error (not a tool error).

**What it checks:**

- Unknown tool call returns a JSON-RPC error
- The error code is a JSON-RPC protocol error code: a standard one (`-32700`, `-32600` to `-32603`; `-32601` Method not found fits best) or one from the server-error range (`-32000` to `-32099`)

**How to fix:**
Ensure your server returns a protocol error (JSON-RPC error object) when an unknown tool is called, not a successful response with `isError: true`.

### errors/invalid-params

**Severity:** warning

Tests that calling a tool without its required parameters returns a protocol error.

**What it checks:**

- Missing required params return a JSON-RPC error
- The error code is a JSON-RPC protocol error code (the same set as `errors/unknown-tool`; `-32602` Invalid params fits best)

A call that returns a result instead — even one with `isError: true` — is a warning: the request was invalid, so it should be rejected at the protocol layer.

**How to fix:**
Validate tool inputs against the schema and return a JSON-RPC error for schema violations.

---

## Latency Rules

Latency rules measure tool response times against configured budgets. They run only when `checks.latency` is configured.

Measuring a tool means calling it `samples` times, so by default only tools annotated `readOnlyHint: true` (and not `destructiveHint: true`) are measured, with generated minimal arguments. Other tools are measured only when listed in `checks.latency.tools`, with the arguments you give. `checks.latency.call_all: true` restores the pre-1.1.0 behavior of measuring every tool — use it only against a test instance.

### latency/list-tools

**Severity:** error

Tools could not be listed, so latency was not measured.

### latency/no-tools

**Severity:** info

The server exposes no tools.

### latency/sampling

**Severity:** info (warning when an allowlisted tool does not exist)

Lists the tools that were not measured and why, and allowlisted tools that the server does not expose.

**How to fix:**
To measure a tool that is not annotated read-only, add it to `checks.latency.tools` with arguments that are safe to call repeatedly.

### latency/summary

**Severity:** error when p95 exceeds the budget or any call timed out; warning when no tool could be measured (the budget was not evaluated; the run does not fail)

Overall p50 and p95 across all measured calls, compared with `p95_budget_ms`. This is the result that fails the run. A call that times out (`timeouts.call_ms`) fails it on its own: it never completed, so its real latency is unknown and could exceed any budget.

**How to fix:**
Optimize the slow tools, or raise `p95_budget_ms` if the threshold is too strict.

### latency/tool

**Severity:** info; warning when a call timed out or every call failed

Per-tool min, p50, p95 and max. Informational — the budget is enforced by `latency/summary`.

Only completed calls are samples. A call the server rejects (for example because generated arguments fail validation) or that returns `isError: true` is excluded — how fast a server says "no" is not the tool's latency. A call that times out _is_ counted: it was slow. When every call to a tool failed, the tool is reported as a warning with the first error.

**How to fix:**
Add the tool to `checks.latency.tools` with arguments that make the call succeed.
