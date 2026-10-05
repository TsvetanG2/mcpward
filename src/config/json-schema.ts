import { z } from 'zod';
import { ConfigSchema } from './schema.js';

/** Version of the published config schema file (`schemas/config.v1.schema.json`). */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * JSON Schema for `mcpward.yaml`, generated from the zod schema so the two cannot diverge.
 * Describes the INPUT a user writes (defaults are optional), not the parsed result.
 * A test asserts the committed `schemas/config.v1.schema.json` equals this output.
 */
export function configJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(ConfigSchema, { io: 'input', target: 'draft-2020-12' });
  return {
    $schema: generated.$schema,
    $id: `https://raw.githubusercontent.com/TsvetanG2/mcpward/main/schemas/config.v${CONFIG_SCHEMA_VERSION}.schema.json`,
    title: 'mcpward configuration (mcpward.yaml)',
    ...generated,
  };
}
