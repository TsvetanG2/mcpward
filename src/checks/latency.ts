/**
 * Latency checks - Tool call latency budget validation
 *
 * Measures tool call latency and compares against configured budgets:
 * - Runs N samples (default: 5)
 * - Calculates p50 and p95 percentiles
 * - Fails if p95 exceeds configured budget
 *
 * Measuring means calling a tool repeatedly, so only tools that cannot have side effects
 * are measured by default (see decideLatencyCall).
 */

import type { CheckResult } from '../report/model.js';
import type { McpConnection } from '../client/connect.js';
import { listAllTools } from '../client/tools.js';
import type { LatencyConfig } from '../config/schema.js';
import type { Tool } from './schema.js';

export interface LatencyCheckContext {
  connection: McpConnection;
  config: LatencyConfig;
}

const DEFAULT_SAMPLES = 5;
const DEFAULT_P95_BUDGET_MS = 1000;

export interface LatencyCallPolicy {
  call_readonly: boolean;
  tools: { name: string; args: Record<string, unknown> }[];
  call_all: boolean;
}

export type LatencyDecision =
  { call: true; args: Record<string, unknown> } | { call: false; reason: string };

/**
 * Decides whether the latency check may call a tool, and with which arguments.
 * Pure: the whole side-effect policy is this truth table.
 *
 * - allowlisted → called with the configured args
 * - call_all → called with generated minimal args (pre-1.1.0 behavior)
 * - readOnlyHint: true, not destructive, call_readonly → generated minimal args
 * - anything else → refused
 */
export function decideLatencyCall(tool: Tool, policy: LatencyCallPolicy): LatencyDecision {
  const allow = policy.tools.find((t) => t.name === tool.name);
  if (allow) {
    return { call: true, args: allow.args };
  }
  if (policy.call_all) {
    return { call: true, args: buildMinimalArgs(tool) };
  }

  const readOnly = tool.annotations?.readOnlyHint === true;
  const destructive = tool.annotations?.destructiveHint === true;

  if (!readOnly) {
    return {
      call: false,
      reason:
        'not annotated readOnlyHint: true and not in checks.latency.tools — mcpward will not repeatedly call a tool that may have side effects',
    };
  }
  if (destructive) {
    return {
      call: false,
      reason:
        'annotated both readOnlyHint and destructiveHint — contradictory, refusing to call without an explicit checks.latency.tools entry',
    };
  }
  if (!policy.call_readonly) {
    return {
      call: false,
      reason: 'call_readonly is disabled and the tool is not in checks.latency.tools',
    };
  }
  return { call: true, args: buildMinimalArgs(tool) };
}

/**
 * Runs latency checks against all tools.
 */
export async function runLatencyChecks(ctx: LatencyCheckContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const samples = ctx.config?.samples ?? DEFAULT_SAMPLES;
  const p95Budget = ctx.config?.p95_budget_ms ?? DEFAULT_P95_BUDGET_MS;
  const policy: LatencyCallPolicy = {
    call_readonly: ctx.config?.call_readonly ?? true,
    tools: ctx.config?.tools ?? [],
    call_all: ctx.config?.call_all ?? false,
  };

  // Get tools list
  let tools: Tool[];
  try {
    const toolsResult = { tools: await listAllTools(ctx.connection.client) };
    if (!toolsResult.tools || !Array.isArray(toolsResult.tools)) {
      results.push({
        id: 'latency/list-tools',
        family: 'latency',
        status: 'fail',
        severity: 'error',
        message: 'Server returned invalid tools list',
      });
      return results;
    }
    tools = toolsResult.tools as Tool[];
  } catch (err) {
    results.push({
      id: 'latency/list-tools',
      family: 'latency',
      status: 'fail',
      severity: 'error',
      message: `Failed to list tools: ${err instanceof Error ? err.message : String(err)}`,
    });
    return results;
  }

  if (tools.length === 0) {
    results.push({
      id: 'latency/no-tools',
      family: 'latency',
      status: 'pass',
      severity: 'info',
      message: 'No tools to test latency',
    });
    return results;
  }

  // Measure latency for each tool the policy allows
  const allLatencies: number[] = [];
  const refused: { tool: string; reason: string }[] = [];

  for (const tool of tools) {
    const decision = decideLatencyCall(tool, policy);
    if (!decision.call) {
      refused.push({ tool: tool.name, reason: decision.reason });
      continue;
    }
    const toolResult = await measureToolLatency(ctx.connection, tool, decision.args, samples);
    results.push(toolResult.result);
    allLatencies.push(...toolResult.latencies);
  }

  const known = new Set(tools.map((t) => t.name));
  const unknownAllowlisted = policy.tools.map((t) => t.name).filter((name) => !known.has(name));

  if (refused.length > 0 || unknownAllowlisted.length > 0) {
    const parts: string[] = [];
    if (refused.length > 0) {
      parts.push(
        `${refused.length} tool(s) not measured: ${refused.map((r) => r.tool).join(', ')}`
      );
    }
    if (unknownAllowlisted.length > 0) {
      parts.push(`allowlisted but not on the server: ${unknownAllowlisted.join(', ')}`);
    }
    results.push({
      id: 'latency/sampling',
      family: 'latency',
      status: unknownAllowlisted.length > 0 ? 'warn' : 'skip',
      severity: unknownAllowlisted.length > 0 ? 'warning' : 'info',
      message: `Latency: ${parts.join('; ')}. Add tools to checks.latency.tools (with args) to measure them.`,
      actual: { refused, unknownAllowlisted },
    });
  }

  if (allLatencies.length === 0) {
    results.unshift({
      id: 'latency/summary',
      family: 'latency',
      status: 'skip',
      severity: 'warning',
      message:
        'Latency not measured: no tool is annotated readOnlyHint: true or allowlisted in checks.latency.tools',
      expected: `p95 <= ${p95Budget}ms`,
    });
    return results;
  }

  // Calculate overall p50/p95
  const sorted = allLatencies.sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);

  const status = p95 <= p95Budget ? 'pass' : 'fail';

  results.unshift({
    id: 'latency/summary',
    family: 'latency',
    status,
    severity: status === 'pass' ? 'info' : 'error',
    message: `Latency p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms (budget: ${p95Budget}ms)`,
    expected: `p95 <= ${p95Budget}ms`,
    actual: `p95 = ${p95.toFixed(0)}ms`,
  });

  return results;
}

/**
 * Measures latency for a single tool across multiple samples.
 */
async function measureToolLatency(
  connection: McpConnection,
  tool: Tool,
  args: Record<string, unknown>,
  samples: number
): Promise<{ result: CheckResult; latencies: number[] }> {
  const latencies: number[] = [];

  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    try {
      await connection.callTool({ name: tool.name, arguments: args });
    } catch {
      // Tool may fail, but we still measure latency
    }
    const end = performance.now();
    latencies.push(end - start);
  }

  const sorted = latencies.sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;

  return {
    result: {
      id: 'latency/tool',
      family: 'latency',
      status: 'pass', // Individual tool latencies are informational
      severity: 'info',
      message: `Tool "${tool.name}" latency: min=${min.toFixed(0)}ms p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms max=${max.toFixed(0)}ms`,
      location: tool.name,
      actual: { min, p50, p95, max, samples: latencies },
    },
    latencies,
  };
}

/**
 * Builds minimal arguments for a tool to make it callable.
 * Returns empty object for tools without required params.
 */
function buildMinimalArgs(tool: Tool): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (!schema || !schema.properties || !schema.required) {
    return {};
  }

  const args: Record<string, unknown> = {};

  for (const requiredField of schema.required) {
    const prop = schema.properties[requiredField] as { type?: string } | undefined;
    if (prop) {
      // Provide minimal valid values based on type
      args[requiredField] = getDefaultValue(prop.type);
    }
  }

  return args;
}

/**
 * Returns a minimal default value for a JSON Schema type.
 */
function getDefaultValue(type: string | undefined): unknown {
  switch (type) {
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

/**
 * Calculates a percentile from a sorted array.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const first = sorted[0];
  if (first === undefined) return 0;
  if (sorted.length === 1) return first;

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;

  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];

  if (lowerValue === undefined || upperValue === undefined) return 0;

  if (lower === upper) {
    return lowerValue;
  }

  return lowerValue * (1 - fraction) + upperValue * fraction;
}
