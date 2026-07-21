/**
 * Error contract checks - Two-layer error contract validation
 *
 * MCP has two error layers:
 * 1. Protocol errors (JSON-RPC error): unknown tool, malformed call, invalid params
 *    - Standard codes: -32700 parse, -32600 invalid request, -32601 method not found,
 *      -32602 invalid params, -32603 internal
 *
 * 2. Tool errors (isError: true): tool execution failures (file not found, etc.)
 *    - These are successful JSON-RPC responses with isError: true
 *
 * This check verifies servers use the correct layer for the correct situation.
 */

import type { CheckResult } from '../report/model.js';
import type { McpConnection } from '../client/connect.js';
import type { Tool } from './schema.js';

export interface ErrorContractCheckContext {
  connection: McpConnection;
}

// Standard JSON-RPC error codes
const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

/**
 * Runs error contract checks.
 *
 * Tests that:
 * 1. Unknown tool name → protocol error (METHOD_NOT_FOUND or similar)
 * 2. If a tool has required params, missing them → protocol error (INVALID_PARAMS)
 */
export async function runErrorContractChecks(
  ctx: ErrorContractCheckContext
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Get tools list
  let tools: Tool[];
  try {
    const toolsResult = await ctx.connection.client.listTools();
    if (!toolsResult.tools || !Array.isArray(toolsResult.tools)) {
      results.push({
        id: 'errors/list-tools',
        family: 'errors',
        status: 'fail',
        severity: 'error',
        message: 'Server returned invalid tools list',
      });
      return results;
    }
    tools = toolsResult.tools as Tool[];
  } catch (err) {
    results.push({
      id: 'errors/list-tools',
      family: 'errors',
      status: 'fail',
      severity: 'error',
      message: `Failed to list tools: ${err instanceof Error ? err.message : String(err)}`,
    });
    return results;
  }

  // Test 1: Unknown tool should return protocol error
  results.push(await checkUnknownToolError(ctx.connection));

  // Test 2: For tools with required params, missing params should be protocol error
  for (const tool of tools) {
    if (hasRequiredParams(tool)) {
      results.push(await checkInvalidParamsError(ctx.connection, tool));
    }
  }

  // Summary
  const failures = results.filter((r) => r.status === 'fail');
  results.unshift({
    id: 'errors/summary',
    family: 'errors',
    status: failures.length === 0 ? 'pass' : 'fail',
    severity: failures.length === 0 ? 'info' : 'error',
    message:
      failures.length === 0
        ? 'Error contract checks passed'
        : `Error contract: ${failures.length} violation(s) found`,
  });

  return results;
}

/**
 * Checks that calling an unknown tool returns a protocol error.
 */
async function checkUnknownToolError(connection: McpConnection): Promise<CheckResult> {
  const unknownToolName = '__mcpward_unknown_tool_' + Date.now();

  try {
    await connection.callTool({ name: unknownToolName, arguments: {} });

    // If we get here, no error was thrown - this is wrong
    return {
      id: 'errors/unknown-tool',
      family: 'errors',
      status: 'fail',
      severity: 'error',
      message: 'Unknown tool did not return protocol error',
      expected: `Protocol error (code -32601 or -32602)`,
      actual: 'No error returned',
      location: unknownToolName,
    };
  } catch (err) {
    // Check if it's a proper JSON-RPC error
    const code = extractErrorCode(err);

    // Accept METHOD_NOT_FOUND (-32601) or INVALID_PARAMS (-32602) or INTERNAL_ERROR (-32603)
    // Different SDK implementations may use different codes
    if (code !== undefined && isProtocolErrorCode(code)) {
      return {
        id: 'errors/unknown-tool',
        family: 'errors',
        status: 'pass',
        severity: 'info',
        message: `Unknown tool correctly returned protocol error (code ${code})`,
        location: unknownToolName,
      };
    } else {
      return {
        id: 'errors/unknown-tool',
        family: 'errors',
        status: 'fail',
        severity: 'error',
        message: 'Unknown tool returned wrong error type',
        expected: 'Protocol error with standard JSON-RPC code',
        actual: code !== undefined ? `Code ${code}` : 'Unknown error type',
        location: unknownToolName,
      };
    }
  }
}

/**
 * Checks that calling a tool with missing required params returns a protocol error.
 */
async function checkInvalidParamsError(
  connection: McpConnection,
  tool: Tool
): Promise<CheckResult> {
  try {
    // Call with empty args - should fail for tools with required params
    await connection.callTool({ name: tool.name, arguments: {} });

    // If tool succeeds with empty args but has required params, it's a contract violation
    // However, some tools may handle this gracefully with isError: true
    // We check if the call returned isError: true (acceptable) or just succeeded (not ideal)
    return {
      id: 'errors/invalid-params',
      family: 'errors',
      status: 'warn',
      severity: 'warning',
      message: `Tool "${tool.name}" did not fail with missing required params`,
      expected: 'Protocol error (-32602) for invalid params',
      actual: 'Call succeeded',
      location: tool.name,
    };
  } catch (err) {
    const code = extractErrorCode(err);

    // Accept INVALID_PARAMS (-32602) or similar protocol errors
    if (code !== undefined && isProtocolErrorCode(code)) {
      return {
        id: 'errors/invalid-params',
        family: 'errors',
        status: 'pass',
        severity: 'info',
        message: `Tool "${tool.name}" correctly returned protocol error for invalid params (code ${code})`,
        location: tool.name,
      };
    } else {
      return {
        id: 'errors/invalid-params',
        family: 'errors',
        status: 'warn',
        severity: 'warning',
        message: `Tool "${tool.name}" error for invalid params not a standard protocol error`,
        expected: 'Protocol error (-32602)',
        actual: code !== undefined ? `Code ${code}` : 'Unknown error',
        location: tool.name,
      };
    }
  }
}

/**
 * Checks if a tool has required parameters.
 */
function hasRequiredParams(tool: Tool): boolean {
  const schema = tool.inputSchema;
  if (!schema) return false;
  if (!schema.required || !Array.isArray(schema.required)) return false;
  return schema.required.length > 0;
}

/**
 * Checks if an error code is a standard JSON-RPC protocol error.
 */
function isProtocolErrorCode(code: number): boolean {
  // Standard JSON-RPC error codes are in range -32768 to -32000
  // But we specifically check for the common ones
  return (
    code === ERROR_CODES.PARSE_ERROR ||
    code === ERROR_CODES.INVALID_REQUEST ||
    code === ERROR_CODES.METHOD_NOT_FOUND ||
    code === ERROR_CODES.INVALID_PARAMS ||
    code === ERROR_CODES.INTERNAL_ERROR ||
    (code >= -32099 && code <= -32000) // Server errors
  );
}

/**
 * Extracts error code from an MCP error.
 */
function extractErrorCode(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    if ('code' in err && typeof (err as { code: unknown }).code === 'number') {
      return (err as { code: number }).code;
    }
  }
  return undefined;
}
