import { z } from 'zod';
import { ConfigSchema } from './schema.js';

/** Version of the published config schema file (`schemas/config.v1.schema.json`). */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * `server.url` as a user writes it: an http(s) URL — the only schemes the parser accepts —
 * or a string containing a `${ENV_VAR}` placeholder, which loadConfig expands BEFORE
 * validating. A plain `format: "uri"` both accepts schemes the parser rejects (file:, ftp:)
 * and rejects placeholders the parser accepts.
 */
const RAW_SERVER_URL = {
  type: 'string',
  anyOf: [
    // A literal URL: http(s) scheme (case-insensitive — the parser accepts `HTTPS://`), then an
    // explicit authority check: optional userinfo, host or [IPv6], NUMERIC port. `format: uri`
    // alone is not enough — ajv-formats accepts `https://host:abc/`, which URL() rejects.
    {
      format: 'uri',
      pattern:
        '^[hH][tT][tT][pP][sS]?://([^/?#\\s@]+@)?(\\[[0-9A-Fa-f:.]+\\]|[^/?#\\s:@\\[\\]]+)' +
        // port 0–65535
        '(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[0-9]{1,4}))?' +
        '([/?#]\\S*)?$',
    },
    // A placeholder expanded at load time; the expanded value is validated by the parser.
    { pattern: '\\$\\{[^}]+\\}' },
  ],
  description:
    'Streamable HTTP endpoint (http or https), or a value containing a ${ENV_VAR} placeholder resolved at load time.',
};

/** Points the generated http-transport `url` at RAW_SERVER_URL. */
function patchServerUrl(schema: Record<string, unknown>): void {
  const server = (schema.properties as Record<string, { oneOf?: unknown[] }> | undefined)?.server;
  const http = server?.oneOf?.find(
    (branch) =>
      (branch as { properties?: { transport?: { const?: unknown } } }).properties?.transport?.const === 'http'
  ) as { properties: Record<string, unknown> } | undefined;
  if (!http) {
    throw new Error('config JSON Schema: http transport branch not found — update patchServerUrl');
  }
  http.properties.url = RAW_SERVER_URL;
}

/**
 * JSON Schema for `mcpward.yaml`, generated from the zod schema so the two cannot diverge.
 * Describes the raw file a user writes: defaults are optional and `${ENV_VAR}` placeholders
 * are allowed where they are expanded. A test asserts the committed
 * `schemas/config.v1.schema.json` equals this output.
 */
export function configJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(ConfigSchema, { io: 'input', target: 'draft-2020-12' }) as Record<
    string,
    unknown
  >;
  patchServerUrl(generated);
  return {
    $schema: generated.$schema,
    $id: `https://raw.githubusercontent.com/TsvetanG2/mcpward/main/schemas/config.v${CONFIG_SCHEMA_VERSION}.schema.json`,
    title: 'mcpward configuration (mcpward.yaml)',
    ...generated,
  };
}
