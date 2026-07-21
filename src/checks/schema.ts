/**
 * Schema checks
 *
 * Validates tool definitions:
 * - Valid inputSchema (JSON Schema)
 * - Unique names matching ^[a-zA-Z0-9_-]+$
 * - Non-empty descriptions
 * - Well-formed annotations
 */

import type { CheckResult } from '../report/model.js';
import type { McpConnection } from '../client/connect.js';

// Dynamic import for CJS modules - using any for complex module interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let AjvClass: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let addFormats: any;

async function loadAjv() {
  const ajvModule = await import('ajv');
  const formatsModule = await import('ajv-formats');
  AjvClass = ajvModule.default;
  addFormats = formatsModule.default;
}

// Tool name pattern from MCP spec
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface SchemaCheckContext {
  connection: McpConnection;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
}

/**
 * Runs all schema checks.
 */
export async function runSchemaChecks(
  ctx: SchemaCheckContext
): Promise<CheckResult[]> {
  // Load ajv dynamically (CJS module)
  await loadAjv();

  const results: CheckResult[] = [];

  // Get tools list
  let tools: Tool[];
  try {
    const toolsResult = await ctx.connection.client.listTools();
    if (!toolsResult.tools || !Array.isArray(toolsResult.tools)) {
      results.push({
        id: 'schema/list-tools',
        family: 'schema',
        status: 'fail',
        severity: 'error',
        message: 'Server returned invalid tools list',
        expected: 'Array of tools',
        actual: typeof toolsResult.tools,
      });
      return results;
    }
    tools = toolsResult.tools as Tool[];
  } catch (err) {
    results.push({
      id: 'schema/list-tools',
      family: 'schema',
      status: 'fail',
      severity: 'error',
      message: `Failed to list tools: ${err instanceof Error ? err.message : String(err)}`,
      actual: err instanceof Error ? err.message : String(err),
    });
    return results;
  }

  // Check for duplicate names
  const nameCount = new Map<string, number>();
  for (const tool of tools) {
    nameCount.set(tool.name, (nameCount.get(tool.name) ?? 0) + 1);
  }

  for (const [name, count] of nameCount) {
    if (count > 1) {
      results.push({
        id: 'schema/unique-names',
        family: 'schema',
        status: 'fail',
        severity: 'error',
        message: `Duplicate tool name: "${name}" appears ${count} times`,
        expected: 'Unique tool names',
        actual: `"${name}" appears ${count} times`,
        location: name,
      });
    }
  }

  // Check each tool
  for (const tool of tools) {
    results.push(...checkTool(tool));
  }

  // Overall summary if all tools pass
  if (results.every((r) => r.status === 'pass')) {
    results.unshift({
      id: 'schema/summary',
      family: 'schema',
      status: 'pass',
      severity: 'info',
      message: `All ${tools.length} tools have valid schemas`,
    });
  }

  return results;
}

function checkTool(tool: Tool): CheckResult[] {
  const results: CheckResult[] = [];

  // Check tool name format
  results.push(checkToolName(tool));

  // Check description
  results.push(checkToolDescription(tool));

  // Check inputSchema
  results.push(checkToolInputSchema(tool));

  // Check annotations if present
  if (tool.annotations) {
    results.push(checkToolAnnotations(tool));
  }

  return results;
}

function checkToolName(tool: Tool): CheckResult {
  const { name } = tool;

  if (!name || name.trim() === '') {
    return {
      id: 'schema/tool-name',
      family: 'schema',
      status: 'fail',
      severity: 'error',
      message: 'Tool has empty or missing name',
      expected: 'Non-empty tool name matching ^[a-zA-Z0-9_-]+$',
      actual: name,
    };
  }

  if (!TOOL_NAME_PATTERN.test(name)) {
    return {
      id: 'schema/tool-name',
      family: 'schema',
      status: 'fail',
      severity: 'error',
      message: `Tool name "${name}" contains invalid characters`,
      expected: 'Name matching ^[a-zA-Z0-9_-]+$',
      actual: name,
      location: name,
    };
  }

  return {
    id: 'schema/tool-name',
    family: 'schema',
    status: 'pass',
    severity: 'info',
    message: `Tool "${name}" has valid name`,
    location: name,
  };
}

function checkToolDescription(tool: Tool): CheckResult {
  const { name, description } = tool;

  if (description === undefined || description === null) {
    return {
      id: 'schema/tool-description',
      family: 'schema',
      status: 'fail',
      severity: 'error',
      message: `Tool "${name}" has no description`,
      expected: 'Non-empty description',
      actual: 'undefined',
      location: name,
    };
  }

  if (typeof description !== 'string') {
    return {
      id: 'schema/tool-description',
      family: 'schema',
      status: 'fail',
      severity: 'error',
      message: `Tool "${name}" has non-string description`,
      expected: 'String description',
      actual: typeof description,
      location: name,
    };
  }

  if (description.trim() === '') {
    return {
      id: 'schema/tool-description',
      family: 'schema',
      status: 'fail',
      severity: 'error',
      message: `Tool "${name}" has empty description`,
      expected: 'Non-empty description',
      actual: '""',
      location: name,
    };
  }

  return {
    id: 'schema/tool-description',
    family: 'schema',
    status: 'pass',
    severity: 'info',
    message: `Tool "${name}" has description`,
    location: name,
  };
}

function checkToolInputSchema(tool: Tool): CheckResult {
  const { name, inputSchema } = tool;

  if (!inputSchema) {
    return {
      id: 'schema/tool-input-schema',
      family: 'schema',
      status: 'warn',
      severity: 'warning',
      message: `Tool "${name}" has no inputSchema`,
      expected: 'JSON Schema object',
      actual: 'undefined',
      location: name,
    };
  }

  // Check that inputSchema.type is 'object'
  if (inputSchema.type !== 'object') {
    return {
      id: 'schema/tool-input-schema',
      family: 'schema',
      status: 'fail',
      severity: 'error',
      message: `Tool "${name}" inputSchema.type must be "object"`,
      expected: '"object"',
      actual: inputSchema.type,
      location: name,
    };
  }

  // Validate that the schema itself is valid JSON Schema
  const ajv = new AjvClass({ allErrors: true, strict: false });
  addFormats(ajv);

  try {
    // Try to compile the schema - this validates its structure
    ajv.compile(inputSchema);
  } catch (err) {
    return {
      id: 'schema/tool-input-schema',
      family: 'schema',
      status: 'fail',
      severity: 'error',
      message: `Tool "${name}" has invalid inputSchema: ${err instanceof Error ? err.message : String(err)}`,
      expected: 'Valid JSON Schema',
      actual: err instanceof Error ? err.message : String(err),
      location: name,
    };
  }

  // Check for unknown types in properties (common mistake)
  if (inputSchema.properties) {
    for (const [propName, propSchema] of Object.entries(inputSchema.properties)) {
      const prop = propSchema as { type?: string };
      if (prop.type && !isValidJsonSchemaType(prop.type)) {
        return {
          id: 'schema/tool-input-schema',
          family: 'schema',
          status: 'fail',
          severity: 'error',
          message: `Tool "${name}" property "${propName}" has invalid type: "${prop.type}"`,
          expected: 'Valid JSON Schema type (string, number, integer, boolean, array, object, null)',
          actual: prop.type,
          location: `${name}.${propName}`,
        };
      }
    }
  }

  return {
    id: 'schema/tool-input-schema',
    family: 'schema',
    status: 'pass',
    severity: 'info',
    message: `Tool "${name}" has valid inputSchema`,
    location: name,
  };
}

function isValidJsonSchemaType(type: string): boolean {
  const validTypes = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
  return validTypes.includes(type);
}

function checkToolAnnotations(tool: Tool): CheckResult {
  const { name, annotations } = tool;

  if (!annotations) {
    return {
      id: 'schema/tool-annotations',
      family: 'schema',
      status: 'pass',
      severity: 'info',
      message: `Tool "${name}" has no annotations`,
      location: name,
    };
  }

  // Check that annotation values are booleans where expected
  const booleanAnnotations = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

  for (const key of booleanAnnotations) {
    const value = annotations[key];
    if (value !== undefined && typeof value !== 'boolean') {
      return {
        id: 'schema/tool-annotations',
        family: 'schema',
        status: 'fail',
        severity: 'error',
        message: `Tool "${name}" annotation "${key}" should be boolean`,
        expected: 'boolean',
        actual: typeof value,
        location: name,
      };
    }
  }

  return {
    id: 'schema/tool-annotations',
    family: 'schema',
    status: 'pass',
    severity: 'info',
    message: `Tool "${name}" has valid annotations`,
    location: name,
  };
}
