/**
 * Latency checks - Tool call latency budget validation
 *
 * Measures tool call latency and compares against configured budgets:
 * - Runs N samples (default: 5)
 * - Calculates p50 and p95 percentiles
 * - Fails if p95 exceeds configured budget
 */

import type { CheckResult } from '../report/model.js';
import type { McpConnection } from '../client/connect.js';
import type { LatencyConfig } from '../config/schema.js';
import type { Tool } from './schema.js';

export interface LatencyCheckContext {
  connection: McpConnection;
  config: LatencyConfig;
}

const DEFAULT_SAMPLES = 5;
const DEFAULT_P95_BUDGET_MS = 1000;

/**
 * Runs latency checks against all tools.
 */
export async function runLatencyChecks(
  ctx: LatencyCheckContext
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const samples = ctx.config?.samples ?? DEFAULT_SAMPLES;
  const p95Budget = ctx.config?.p95_budget_ms ?? DEFAULT_P95_BUDGET_MS;

  // Get tools list
  let tools: Tool[];
  try {
    const toolsResult = await ctx.connection.client.listTools();
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

  // Measure latency for each tool
  const allLatencies: number[] = [];

  for (const tool of tools) {
    const toolResult = await measureToolLatency(ctx.connection, tool, samples);
    results.push(toolResult.result);
    allLatencies.push(...toolResult.latencies);
  }

  // Calculate overall p50/p95
  if (allLatencies.length > 0) {
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
  }

  return results;
}

/**
 * Measures latency for a single tool across multiple samples.
 */
async function measureToolLatency(
  connection: McpConnection,
  tool: Tool,
  samples: number
): Promise<{ result: CheckResult; latencies: number[] }> {
  const latencies: number[] = [];

  // Build minimal valid args for the tool
  const args = buildMinimalArgs(tool);

  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    try {
      await connection.client.callTool({ name: tool.name, arguments: args });
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
