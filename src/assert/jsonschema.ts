/**
 * JSON Schema validation for behavioral tests.
 *
 * Validates tool outputs against JSON schemas using ajv.
 */

// Dynamic import for CJS modules - using any for complex module interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let AjvClass: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let addFormats: any;
let ajvLoaded = false;

async function loadAjv() {
  if (ajvLoaded) return;
  const ajvModule = await import('ajv');
  const formatsModule = await import('ajv-formats');
  AjvClass = ajvModule.default;
  addFormats = formatsModule.default;
  ajvLoaded = true;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  [key: string]: unknown;
}

export interface ValidationError {
  path: string;
  message: string;
}

/**
 * Validates a value against a JSON Schema.
 *
 * @param schema - The JSON Schema to validate against
 * @param value - The value to validate
 * @returns Array of validation errors (empty if valid)
 */
export async function validateSchema(
  schema: JsonSchema,
  value: unknown
): Promise<ValidationError[]> {
  await loadAjv();

  const ajv = new AjvClass({ allErrors: true, strict: false });
  addFormats(ajv);

  try {
    const validate = ajv.compile(schema);
    const valid = validate(value);

    if (valid) {
      return [];
    }

    // Map ajv errors to our format
    return (validate.errors ?? []).map((err: { instancePath?: string; message?: string }) => ({
      path: err.instancePath || '$',
      message: err.message || 'Unknown validation error',
    }));
  } catch (err) {
    return [
      {
        path: '$',
        message: `Schema compilation error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }
}

/**
 * Validates that a tool result matches the expected MCP content structure.
 *
 * MCP tool results have the form:
 * {
 *   content: Array<{ type: string, text?: string, ... }>,
 *   isError?: boolean
 * }
 */
export async function validateToolResult(result: unknown): Promise<ValidationError[]> {
  const toolResultSchema: JsonSchema = {
    type: 'object',
    properties: {
      content: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
          },
          required: ['type'],
        },
      },
      isError: { type: 'boolean' },
    },
    required: ['content'],
  };

  return validateSchema(toolResultSchema, result);
}

/**
 * Validates that a value matches a tool's outputSchema.
 */
export async function validateAgainstOutputSchema(
  outputSchema: JsonSchema | null | undefined,
  value: unknown
): Promise<{ valid: boolean; errors: ValidationError[] }> {
  if (!outputSchema) {
    // No output schema defined - always passes
    return { valid: true, errors: [] };
  }

  const errors = await validateSchema(outputSchema, value);
  return {
    valid: errors.length === 0,
    errors,
  };
}
