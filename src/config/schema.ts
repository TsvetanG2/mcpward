import { z } from 'zod';

// Server transport configuration
const StdioTransportSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional().default({}),
});

const HttpTransportSchema = z.object({
  transport: z.literal('http'),
  url: z.url({ protocol: /^https?$/ }),
  headers: z.record(z.string(), z.string()).optional().default({}),
});

const ServerSchema = z.discriminatedUnion('transport', [StdioTransportSchema, HttpTransportSchema]);

// Expectations
const ExpectSchema = z
  .object({
    protocol_version: z.string().optional(),
  })
  .optional();

// Drift classes — keep in sync with DriftClass in src/surface/types.ts
export const DRIFT_CLASSES = [
  'tool_removed',
  'tool_added',
  'description_changed',
  'breaking_schema_change',
  'nonbreaking_schema_change',
  'annotation_changed',
  'breaking_output_shape_change',
  'nonbreaking_output_shape_change',
] as const;

const DriftSeveritySchema = z.enum(['high', 'medium', 'low']);

/** Tools a check may call regardless of annotations, with the arguments to call them with. */
const ToolAllowlistSchema = z
  .array(
    z.object({
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional().default({}),
    })
  )
  .optional()
  .default([]);

/**
 * Output shape drift (M3). Calls tools to infer response shapes, so it is opt-in and
 * only calls tools that are allowlisted here or annotated `readOnlyHint: true`.
 */
const OutputDriftConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    /** Calls per tool. Shapes are merged across samples; never infer from one response if avoidable. */
    shape_samples: z.number().int().min(1).optional().default(3),
    /** Auto-call tools annotated readOnlyHint: true that take no required arguments. */
    call_readonly: z.boolean().optional().default(true),
    /** Explicit allowlist. Listed tools are called with `args` regardless of annotations. */
    tools: ToolAllowlistSchema,
  })
  .optional();

// Drift check configuration
const DriftConfigSchema = z
  .object({
    baseline: z.string().optional().default('./mcpward.lock.json'),
    /**
     * Fail condition - either a list of drift classes OR a severity threshold (M2).
     *
     * Array of drift classes (legacy, still supported):
     *   fail_on: ['tool_removed', 'description_changed', ...]
     *
     * Severity threshold (M2 - recommended):
     *   fail_on: 'high'     - fail only on high severity (rug-pulls, permission expansion)
     *   fail_on: 'medium'   - fail on high and medium (includes schema breaks)
     *   fail_on: 'low'      - fail on everything
     *
     * Severity is based on blast radius, NOT whether it breaks:
     * - high: silent security changes (description_changed, annotation_changed)
     * - medium: loud schema breaks (breaking_schema_change)
     * - low: visible changes (tool_added, tool_removed, nonbreaking_schema_change)
     */
    fail_on: z
      .union([
        // Legacy: array of drift classes
        z.array(z.enum(DRIFT_CLASSES)),
        // M2: severity threshold
        DriftSeveritySchema,
      ])
      .optional()
      .default([
        'tool_removed',
        'description_changed',
        'breaking_schema_change',
        'annotation_changed',
        'breaking_output_shape_change',
      ]),
    /**
     * Per-class severity overrides (M2). For users who disagree with the default
     * blast-radius mapping, e.g. `severity: { tool_removed: high }`.
     * Only affects severity-threshold `fail_on` and reporting level.
     */
    severity: z.partialRecord(z.enum(DRIFT_CLASSES), DriftSeveritySchema).optional().default({}),
    /**
     * Output shape drift (M3). Off by default: it CALLS TOOLS.
     */
    output: OutputDriftConfigSchema,
    /**
     * Store full description text in lockfile for before/after diffs.
     * Default true - size cost is small, diff quality gain is significant.
     * Set false for very large tool surfaces (100+ tools) if lockfile size matters.
     * Added in M1 (lockfile v2).
     */
    full_text: z.boolean().optional().default(true),
  })
  .optional();

// Latency check configuration. Calls tools repeatedly, so (since 1.1.0) only tools that are
// annotated read-only or allowlisted — the same policy as output drift.
const LatencyConfigSchema = z
  .object({
    samples: z.number().int().positive().optional().default(5),
    p95_budget_ms: z.number().positive().optional().default(1000),
    /** Measure tools annotated readOnlyHint: true (not destructive), with generated minimal arguments. */
    call_readonly: z.boolean().optional().default(true),
    /** Explicit allowlist. Listed tools are measured with `args` regardless of annotations. */
    tools: ToolAllowlistSchema,
    /** Pre-1.1.0 behavior: measure every tool, destructive ones included. Only for test instances. */
    call_all: z.boolean().optional().default(false),
  })
  .optional();

// Description collision lint (M4). Runs on a single surface; no baseline needed.
const CollisionConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    /** Description similarity at or above which a pair is a candidate (0–1). */
    threshold: z.number().min(0).max(1).optional().default(0.8),
    /** Pairwise comparison is O(n²); above this many tools the lint is skipped with a warning. */
    max_tools: z.number().int().positive().optional().default(500),
    /** Findings warn by default; set true to fail the run on any collision. */
    fail: z.boolean().optional().default(false),
  })
  .optional();

// Timeout configuration (inner object with required fields after defaults)
const TimeoutConfigInnerSchema = z.object({
  connect_ms: z.number().int().positive().default(10000),
  call_ms: z.number().int().positive().default(30000),
  run_ms: z.number().int().positive().default(300000),
});

// Timeout configuration (optional in config, but has defaults)
const TimeoutConfigSchema = TimeoutConfigInnerSchema.optional();

// Checks configuration
const ChecksSchema = z
  .object({
    compliance: z.boolean().optional().default(true),
    schema: z.boolean().optional().default(true),
    security: z.boolean().optional().default(true),
    /** Error-contract checks call an unknown tool and every tool with required params, with `{}`. */
    errors: z.boolean().optional().default(true),
    drift: DriftConfigSchema,
    latency: LatencyConfigSchema,
    collision: CollisionConfigSchema,
  })
  .optional();

// Behavioral test case expectation
const CaseExpectSchema = z.object({
  tool_is_error: z.boolean().optional(),
  protocol_error_code: z.number().int().optional(),
  output_matches_schema: z.boolean().optional(),
  jsonpath: z.record(z.string(), z.unknown()).optional(),
  golden: z.string().optional(),
});

// Behavioral test case
const TestCaseSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()).optional().default({}),
  expect: CaseExpectSchema.optional(),
});

// Behavioral test suite
const TestSuiteSchema = z.object({
  tool: z.string(),
  cases: z.array(TestCaseSchema),
});

// Full config schema
export const ConfigSchema = z.object({
  server: ServerSchema,
  expect: ExpectSchema,
  checks: ChecksSchema,
  timeouts: TimeoutConfigSchema,
  suites: z.array(TestSuiteSchema).optional().default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
/** Config as written by a user, before defaults are applied. */
export type ConfigInput = z.input<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof ServerSchema>;
export type StdioTransport = z.infer<typeof StdioTransportSchema>;
export type HttpTransport = z.infer<typeof HttpTransportSchema>;
export type DriftConfig = z.infer<typeof DriftConfigSchema>;
export type OutputDriftConfig = z.infer<typeof OutputDriftConfigSchema>;
export type LatencyConfig = z.infer<typeof LatencyConfigSchema>;
export type CollisionConfig = z.infer<typeof CollisionConfigSchema>;
export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
export type ResolvedTimeoutConfig = z.infer<typeof TimeoutConfigInnerSchema>;
export type TestSuite = z.infer<typeof TestSuiteSchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;
