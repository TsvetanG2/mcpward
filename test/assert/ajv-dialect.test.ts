/**
 * Schemas are compiled with the Ajv build that matches their `$schema`. The default build only
 * knows draft-07: a 2020-12 schema failed to compile (a false `schema/tool-input-schema`
 * failure) and `prefixItems` was not enforced on tool output.
 */

import { describe, it, expect } from 'vitest';
import { validateSchema } from '../../src/assert/jsonschema.js';
import { runSchemaChecks } from '../../src/checks/schema.js';
import type { McpConnection } from '../../src/client/connect.js';

const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema';
const DRAFT_2019 = 'https://json-schema.org/draft/2019-09/schema';
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

function connectionWith(tools: unknown[]): McpConnection {
  return { client: { listTools: async () => ({ tools }) } } as unknown as McpConnection;
}

async function inputSchemaResult(inputSchema: Record<string, unknown>) {
  const results = await runSchemaChecks({
    connection: connectionWith([{ name: 'search', description: 'Searches.', inputSchema }]),
  });
  return results.find((r) => r.id === 'schema/tool-input-schema');
}

describe('schema/tool-input-schema by dialect', () => {
  it.each([DRAFT_2020, DRAFT_2019, DRAFT_07, undefined])('accepts a valid %s schema', async (d) => {
    const result = await inputSchemaResult({
      ...(d ? { $schema: d } : {}),
      type: 'object',
      properties: { q: { type: 'string' } },
    });
    expect(result?.status).toBe('pass');
  });

  it('accepts 2020-12 keywords such as prefixItems and $defs', async () => {
    const result = await inputSchemaResult({
      $schema: DRAFT_2020,
      type: 'object',
      properties: {
        pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
        node: { $ref: '#/$defs/Node' },
      },
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
    });
    expect(result?.status).toBe('pass');
  });

  it('still fails an invalid 2020-12 schema', async () => {
    const result = await inputSchemaResult({
      $schema: DRAFT_2020,
      type: 'object',
      properties: { q: { type: 'string', minLength: 'three' } },
    });
    expect(result?.status).toBe('fail');
  });
});

describe('output validation by dialect', () => {
  const pair = {
    $schema: DRAFT_2020,
    type: 'array',
    prefixItems: [{ type: 'string' }, { type: 'number' }],
  };

  it('enforces prefixItems for a 2020-12 schema', async () => {
    expect(await validateSchema(pair, ['a', 1])).toEqual([]);
    expect(await validateSchema(pair, [1, 'a'])).not.toEqual([]);
  });

  it('keeps draft-07 behavior for a schema without $schema', async () => {
    const tuple = { type: 'array', items: [{ type: 'string' }] };
    expect(await validateSchema(tuple, [1])).not.toEqual([]);
  });
});
