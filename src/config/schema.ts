import { z } from 'zod';

// Server transport configuration
const StdioTransportSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string()).optional().default({}),
});

const HttpTransportSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).optional().default({}),
});

const ServerSchema = z.discriminatedUnion('transport', [
  StdioTransportSchema,
  HttpTransportSchema,
]);

// Expectations
const ExpectSchema = z
  .object({
    protocol_version: z.string().optional(),
  })
  .optional();

// Drift check configuration
const DriftConfigSchema = z
  .object({
    baseline: z.string().optional().default('./mcpward.lock.json'),
    fail_on: z
      .array(
        z.enum([
          'tool_removed',
          'tool_added',
          'description_changed',
          'breaking_schema_change',
          'nonbreaking_schema_change',
          'annotation_changed',
        ])
      )
      .optional()
      .default([
        'tool_removed',
        'description_changed',
        'breaking_schema_change',
        'annotation_changed',
      ]),
  })
  .optional();

// Latency check configuration
const LatencyConfigSchema = z
  .object({
    samples: z.number().int().positive().optional().default(5),
    p95_budget_ms: z.number().positive().optional().default(1000),
  })
  .optional();

// Checks configuration
const ChecksSchema = z
  .object({
    compliance: z.boolean().optional().default(true),
    schema: z.boolean().optional().default(true),
    security: z.boolean().optional().default(true),
    drift: DriftConfigSchema,
    latency: LatencyConfigSchema,
  })
  .optional();

// Behavioral test case expectation
const CaseExpectSchema = z.object({
  tool_is_error: z.boolean().optional(),
  protocol_error_code: z.number().int().optional(),
  output_matches_schema: z.boolean().optional(),
  jsonpath: z.record(z.unknown()).optional(),
  golden: z.string().optional(),
});

// Behavioral test case
const TestCaseSchema = z.object({
  name: z.string(),
  args: z.record(z.unknown()).optional().default({}),
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
  suites: z.array(TestSuiteSchema).optional().default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof ServerSchema>;
export type StdioTransport = z.infer<typeof StdioTransportSchema>;
export type HttpTransport = z.infer<typeof HttpTransportSchema>;
export type DriftConfig = z.infer<typeof DriftConfigSchema>;
export type LatencyConfig = z.infer<typeof LatencyConfigSchema>;
export type TestSuite = z.infer<typeof TestSuiteSchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;
