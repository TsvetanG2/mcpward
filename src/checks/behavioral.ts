/**
 * Behavioral checks - Declarative test suites
 *
 * Runs user-defined test cases against tools:
 * - Call tool with args
 * - Assert on result: tool_is_error, protocol_error_code, output_matches_schema, jsonpath
 * - Optional golden snapshot comparison
 */

import type { CheckResult } from '../report/model.js';
import type { McpConnection } from '../client/connect.js';
import type { TestSuite, TestCase } from '../config/schema.js';
import { assertJsonPaths } from '../assert/jsonpath.js';
import { validateAgainstOutputSchema, type JsonSchema } from '../assert/jsonschema.js';

export interface BehavioralCheckContext {
  connection: McpConnection;
  suites: TestSuite[];
}

/**
 * Runs all behavioral test suites.
 */
export async function runBehavioralChecks(
  ctx: BehavioralCheckContext
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  if (ctx.suites.length === 0) {
    return results; // No suites defined
  }

  // Get tools list for schema validation
  let toolsMap: Map<string, { inputSchema?: JsonSchema; outputSchema?: JsonSchema }>;
  try {
    const toolsResult = await ctx.connection.client.listTools();
    toolsMap = new Map(
      toolsResult.tools.map((t) => [
        t.name,
        {
          inputSchema: t.inputSchema as JsonSchema | undefined,
          outputSchema: (t as { outputSchema?: JsonSchema }).outputSchema,
        },
      ])
    );
  } catch (err) {
    results.push({
      id: 'behavioral/list-tools',
      family: 'behavioral',
      status: 'fail',
      severity: 'error',
      message: `Failed to list tools: ${err instanceof Error ? err.message : String(err)}`,
    });
    return results;
  }

  for (const suite of ctx.suites) {
    const toolSchemas = toolsMap.get(suite.tool);
    if (!toolSchemas) {
      results.push({
        id: 'behavioral/tool-exists',
        family: 'behavioral',
        status: 'fail',
        severity: 'error',
        message: `Tool "${suite.tool}" not found on server`,
        location: suite.tool,
      });
      continue;
    }

    for (const testCase of suite.cases) {
      const caseResults = await runTestCase(
        ctx.connection,
        suite.tool,
        testCase,
        toolSchemas.outputSchema
      );
      results.push(...caseResults);
    }
  }

  // Summary
  const failures = results.filter((r) => r.status === 'fail');
  if (results.length > 0) {
    results.unshift({
      id: 'behavioral/summary',
      family: 'behavioral',
      status: failures.length === 0 ? 'pass' : 'fail',
      severity: failures.length === 0 ? 'info' : 'error',
      message:
        failures.length === 0
          ? `All ${results.length} behavioral tests passed`
          : `${failures.length} of ${results.length} behavioral tests failed`,
    });
  }

  return results;
}

/**
 * Runs a single test case.
 */
async function runTestCase(
  connection: McpConnection,
  toolName: string,
  testCase: TestCase,
  outputSchema: JsonSchema | undefined
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const location = `${toolName}/${testCase.name}`;
  const { expect: expectations } = testCase;

  if (!expectations) {
    // No expectations - just run the tool to check it doesn't crash
    try {
      await connection.client.callTool({ name: toolName, arguments: testCase.args });
      results.push({
        id: 'behavioral/case',
        family: 'behavioral',
        status: 'pass',
        severity: 'info',
        message: `Case "${testCase.name}" completed without error`,
        location,
      });
    } catch (err) {
      results.push({
        id: 'behavioral/case',
        family: 'behavioral',
        status: 'fail',
        severity: 'error',
        message: `Case "${testCase.name}" threw unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        location,
      });
    }
    return results;
  }

  // If expecting a protocol error, we expect an exception
  if (expectations.protocol_error_code !== undefined) {
    return await runProtocolErrorCase(connection, toolName, testCase, location);
  }

  // Otherwise, we expect a successful call
  let result: { content: unknown[]; isError?: boolean };
  try {
    result = (await connection.client.callTool({
      name: toolName,
      arguments: testCase.args,
    })) as { content: unknown[]; isError?: boolean };
  } catch (err) {
    // Unexpected protocol error
    results.push({
      id: 'behavioral/case',
      family: 'behavioral',
      status: 'fail',
      severity: 'error',
      message: `Case "${testCase.name}" threw unexpected protocol error: ${err instanceof Error ? err.message : String(err)}`,
      expected: 'Successful tool call',
      actual: err instanceof Error ? err.message : String(err),
      location,
    });
    return results;
  }

  // Check tool_is_error expectation
  if (expectations.tool_is_error !== undefined) {
    const actualIsError = result.isError === true;
    if (actualIsError !== expectations.tool_is_error) {
      results.push({
        id: 'behavioral/tool-is-error',
        family: 'behavioral',
        status: 'fail',
        severity: 'error',
        message: `Case "${testCase.name}" tool_is_error mismatch`,
        expected: expectations.tool_is_error,
        actual: actualIsError,
        location,
      });
    } else {
      results.push({
        id: 'behavioral/tool-is-error',
        family: 'behavioral',
        status: 'pass',
        severity: 'info',
        message: `Case "${testCase.name}" tool_is_error as expected`,
        location,
      });
    }
  }

  // Check output_matches_schema expectation
  if (expectations.output_matches_schema) {
    const validation = await validateAgainstOutputSchema(outputSchema, result);
    if (!validation.valid) {
      results.push({
        id: 'behavioral/output-schema',
        family: 'behavioral',
        status: 'fail',
        severity: 'error',
        message: `Case "${testCase.name}" output does not match schema: ${validation.errors.map((e) => e.message).join(', ')}`,
        expected: 'Valid output schema',
        actual: validation.errors,
        location,
      });
    } else {
      results.push({
        id: 'behavioral/output-schema',
        family: 'behavioral',
        status: 'pass',
        severity: 'info',
        message: `Case "${testCase.name}" output matches schema`,
        location,
      });
    }
  }

  // Check jsonpath expectations
  if (expectations.jsonpath) {
    const failures = assertJsonPaths(expectations.jsonpath, result);
    if (failures.length > 0) {
      for (const failure of failures) {
        results.push({
          id: 'behavioral/jsonpath',
          family: 'behavioral',
          status: 'fail',
          severity: 'error',
          message: `Case "${testCase.name}" JSONPath ${failure.path} mismatch`,
          expected: failure.expected,
          actual: failure.actual,
          location: `${location}:${failure.path}`,
        });
      }
    } else {
      results.push({
        id: 'behavioral/jsonpath',
        family: 'behavioral',
        status: 'pass',
        severity: 'info',
        message: `Case "${testCase.name}" JSONPath assertions passed`,
        location,
      });
    }
  }

  // If no specific expectations checked, mark as pass
  if (
    expectations.tool_is_error === undefined &&
    !expectations.output_matches_schema &&
    !expectations.jsonpath
  ) {
    results.push({
      id: 'behavioral/case',
      family: 'behavioral',
      status: 'pass',
      severity: 'info',
      message: `Case "${testCase.name}" completed`,
      location,
    });
  }

  return results;
}

/**
 * Runs a test case expecting a protocol error.
 */
async function runProtocolErrorCase(
  connection: McpConnection,
  toolName: string,
  testCase: TestCase,
  location: string
): Promise<CheckResult[]> {
  const expectedCode = testCase.expect?.protocol_error_code;

  try {
    await connection.client.callTool({ name: toolName, arguments: testCase.args });

    // If we get here, no error was thrown - fail
    return [
      {
        id: 'behavioral/protocol-error',
        family: 'behavioral',
        status: 'fail',
        severity: 'error',
        message: `Case "${testCase.name}" expected protocol error ${expectedCode} but call succeeded`,
        expected: `Protocol error code ${expectedCode}`,
        actual: 'No error',
        location,
      },
    ];
  } catch (err) {
    // Check if it's the right error code
    const errorCode = extractErrorCode(err);

    if (errorCode === expectedCode) {
      return [
        {
          id: 'behavioral/protocol-error',
          family: 'behavioral',
          status: 'pass',
          severity: 'info',
          message: `Case "${testCase.name}" got expected protocol error ${expectedCode}`,
          location,
        },
      ];
    } else {
      return [
        {
          id: 'behavioral/protocol-error',
          family: 'behavioral',
          status: 'fail',
          severity: 'error',
          message: `Case "${testCase.name}" wrong protocol error code`,
          expected: expectedCode,
          actual: errorCode ?? 'unknown',
          location,
        },
      ];
    }
  }
}

/**
 * Extracts error code from an MCP error.
 */
function extractErrorCode(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    // MCP SDK errors typically have a code property
    if ('code' in err && typeof (err as { code: unknown }).code === 'number') {
      return (err as { code: number }).code;
    }
  }
  return undefined;
}
