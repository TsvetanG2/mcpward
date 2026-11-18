/**
 * fast-check arbitraries and helpers for the property-based tests of the drift classifier and
 * canonicalization.
 *
 * Runs are reproducible: every property uses `FC_SEED` (default fixed) and `FC_NUM_RUNS`.
 * To search harder locally:
 *
 *   FC_NUM_RUNS=5000 pnpm vitest run test/property
 *   FC_SEED=$RANDOM FC_NUM_RUNS=2000 pnpm vitest run test/property
 *
 * A failing run prints the seed and the shrunk counterexample; turn it into a named regression
 * test next to the property.
 */

import fc from 'fast-check';
import { captureToolSurface } from '../../src/surface/capture.js';
import { CANONICAL_VERSION } from '../../src/surface/canonical.js';
import type { JsonSchema, ServerSurface } from '../../src/surface/types.js';
import type { Tool } from '../../src/checks/schema.js';

export const FC_PARAMS: fc.Parameters<unknown> = {
  seed: Number(process.env.FC_SEED ?? 20261118),
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
};

/** Builds a surface from tool definitions the same way `mcpward baseline` does. */
export function surfaceOf(tools: Tool[]): ServerSurface {
  return {
    protocolVersion: '2025-11-25',
    capabilities: { tools: {} },
    tools: Object.fromEntries(tools.map((t) => [t.name, captureToolSurface(t)])),
    meta: {
      schemaVersion: 2,
      mcpwardVersion: 'test',
      canonicalVersion: CANONICAL_VERSION,
      capturedAt: '2026-01-01T00:00:00.000Z',
      serverName: 's',
      serverVersion: '1',
      target: { transport: 'stdio', identity: 'x' },
      authContext: { kind: 'none', keys: [], fingerprint: null, label: null },
      environment: { ci: false, nodeVersion: 'v', platform: 'p' },
    },
  };
}

// --- text ---

const WORDS = [
  'search',
  'records',
  'by',
  'id',
  'café',
  'жълт',
  '数据',
  'the',
  'and',
  'Ñandú',
  '42',
];

/** Descriptions with mixed whitespace, line breaks and non-ASCII letters (no invisible chars). */
export const descriptionArb: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.constantFrom(...WORDS),
      fc.constantFrom(' ', '  ', '\t', '\n', '\r\n', '\n\n'),
      fc.string({ minLength: 1, maxLength: 6 })
    ),
    { minLength: 1, maxLength: 20 }
  )
  .map((parts) => parts.join(''));

/**
 * Any UTF-16 code unit, lone high and low surrogates included. A JSON string from a server may
 * contain them (`"\uD800"` is valid JSON); fast-check's `binary` unit never produces them.
 */
const codeUnitArb = fc.integer({ min: 0, max: 0xffff }).map((u) => String.fromCharCode(u));

/** Strings of arbitrary code units, mixed with well-formed astral characters. */
export const anyCodeUnitsArb = (maxLength?: number): fc.Arbitrary<string> =>
  fc.string({
    unit: fc.oneof(codeUnitArb, fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })),
    ...(maxLength === undefined ? {} : { maxLength }),
  });

/** Identifiers for tool and property names. */
export const identArb = fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,10}$/);

// --- schemas ---

const leafArb: fc.Arbitrary<JsonSchema> = fc.oneof(
  fc.constantFrom('string', 'number', 'integer', 'boolean').map((type) => ({ type })),
  fc
    .uniqueArray(fc.constantFrom('a', 'b', 'c', 'd'), { minLength: 1, maxLength: 4 })
    .map((values) => ({ type: 'string', enum: values })),
  fc.constantFrom('x', 'y').map((value) => ({ const: value })),
  descriptionArb.map((description) => ({ type: 'string', description }))
);

/** Object schema with optional `required`; children come from `child`. */
function objectOf(child: fc.Arbitrary<JsonSchema>): fc.Arbitrary<JsonSchema> {
  return fc.dictionary(identArb, child, { minKeys: 0, maxKeys: 4 }).chain((properties) =>
    fc.subarray(Object.keys(properties)).map((required) => ({
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    }))
  );
}

/** Nested JSON Schemas: objects, arrays, anyOf/oneOf/allOf, enum, const; depth up to 6. */
export const schemaArb: fc.Arbitrary<JsonSchema> = fc.letrec<{ schema: JsonSchema }>((tie) => ({
  schema: fc.oneof(
    { depthSize: 'small', maxDepth: 6, withCrossShrink: true },
    leafArb,
    objectOf(tie('schema')),
    tie('schema').map((items) => ({ type: 'array', items })),
    fc
      .tuple(
        fc.constantFrom('anyOf', 'oneOf', 'allOf'),
        fc.array(tie('schema'), { minLength: 1, maxLength: 3 })
      )
      .map(([key, branches]) => ({ [key]: branches }))
  ),
})).schema;

/** A tool's input schema: an object at the root, sometimes with `$defs` referenced by `$ref`. */
export const inputSchemaArb: fc.Arbitrary<JsonSchema> = fc
  .tuple(objectOf(schemaArb), fc.dictionary(identArb, schemaArb, { maxKeys: 2 }))
  .map(([root, defs]) => {
    const names = Object.keys(defs);
    if (names.length === 0) return root;
    const props = { ...(root.properties as Record<string, JsonSchema>) };
    for (const name of names) props[`ref_${name}`] = { $ref: `#/$defs/${name}` };
    return { ...root, properties: props, $defs: defs };
  });

const annotationsArb = fc.record(
  {
    readOnlyHint: fc.boolean(),
    destructiveHint: fc.boolean(),
    idempotentHint: fc.boolean(),
    openWorldHint: fc.boolean(),
  },
  { requiredKeys: [] }
);

export const toolArb: fc.Arbitrary<Tool> = fc.record(
  {
    name: identArb,
    description: descriptionArb,
    inputSchema: inputSchemaArb,
    annotations: annotationsArb,
  },
  { requiredKeys: ['name', 'inputSchema'] }
);

/** Tools with unique names. */
export const toolsArb: fc.Arbitrary<Tool[]> = fc.uniqueArray(toolArb, {
  minLength: 1,
  maxLength: 4,
  selector: (t) => t.name,
});

// --- transformations that must not produce drift ---

/** Reverses key order at every level and the order of every `required` list. */
export function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).reverse()) {
    const v = (value as Record<string, unknown>)[key];
    out[key] = key === 'required' && Array.isArray(v) ? [...v].reverse() : reorder(v);
  }
  return out;
}

/**
 * Formatting-only edits that canonicalization removes: CRLF line endings, extra spaces and tabs
 * inside and at the ends of lines, NFD instead of NFC.
 */
export function reformat(text: string): string {
  return text
    .normalize('NFD')
    .split(/\r\n|\r|\n/)
    .map((line) => ` \t${line.replace(/ /g, ' \t ')}  `)
    .join('\r\n');
}

/** Keywords through which the classifier compares subschemas node by node. */
const WALKED = new Set(['properties', '$defs', 'definitions']);
const WALKED_SCHEMA = new Set(['items', 'additionalProperties', 'inputSchema']);

/**
 * Applies `reformat` to every description the classifier compares node by node: the tool's own,
 * and those reached through `properties`, `items`, `additionalProperties` and `$defs`. Descriptions
 * inside `anyOf`/`oneOf`/`allOf`/`not`/… are left alone: those keywords are compared as raw JSON
 * (known gap, see "formatting inside combinators" in drift.property.test.ts).
 */
export function reformatDescriptions(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      if (k === 'description' && typeof v === 'string') return [k, reformat(v)];
      if (WALKED_SCHEMA.has(k)) return [k, reformatDescriptions(v)];
      if (WALKED.has(k) && v && typeof v === 'object') {
        return [
          k,
          Object.fromEntries(Object.entries(v).map(([n, s]) => [n, reformatDescriptions(s)])),
        ];
      }
      return [k, v];
    })
  );
}

/** Paths (`properties` keys) to every object schema reachable through `properties` only. */
export function objectPaths(schema: JsonSchema, path: string[] = []): string[][] {
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  if (schema.type !== 'object' || !props) return [];
  return [
    path,
    ...Object.entries(props).flatMap(([k, v]) =>
      v && typeof v === 'object' ? objectPaths(v, [...path, k]) : []
    ),
  ];
}

/** A copy of `schema` with `name: field` added to the object at `path` (required or not). */
export function withField(
  schema: JsonSchema,
  path: string[],
  name: string,
  field: JsonSchema,
  required: boolean
): JsonSchema {
  const copy = structuredClone(schema);
  let node = copy;
  for (const key of path) node = (node.properties as Record<string, JsonSchema>)[key] as JsonSchema;
  node.properties = { ...(node.properties as Record<string, JsonSchema>), [name]: field };
  if (required) node.required = [...((node.required as string[] | undefined) ?? []), name];
  return copy;
}
