/**
 * Property-based tests for the drift classifier (`src/surface/diff.ts`), on surfaces captured the
 * way `mcpward baseline` captures them. Seed and run count: see `FC_PARAMS` in ./arbitraries.ts.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { diffSurfaces } from '../../src/surface/diff.js';
import { canonicalizeDescription } from '../../src/surface/canonical.js';
import type { JsonSchema } from '../../src/surface/types.js';
import type { Tool } from '../../src/checks/schema.js';
import {
  FC_PARAMS,
  descriptionArb,
  identArb,
  objectPaths,
  reformatDescriptions,
  reorder,
  schemaArb,
  surfaceOf,
  toolArb,
  toolsArb,
  withField,
} from './arbitraries.js';

const diff = (before: Tool[], after: Tool[]) =>
  diffSurfaces(surfaceOf(before), surfaceOf(after)).changes;

const BREAKING = new Set(['breaking_schema_change', 'tool_removed', 'description_changed']);

/** A tool plus a path to one of its object schemas, and a field name not declared there. */
const toolWithNewFieldArb = toolArb.chain((tool) => {
  const schema = tool.inputSchema as JsonSchema;
  const paths = objectPaths(schema);
  return fc.record({
    tool: fc.constant(tool),
    path: fc.constantFrom(...paths),
    name: identArb,
    field: schemaArb,
  });
});

function declared(schema: JsonSchema, path: string[]): Record<string, unknown> {
  let node = schema;
  for (const key of path) node = (node.properties as Record<string, JsonSchema>)[key] as JsonSchema;
  return (node.properties as Record<string, unknown> | undefined) ?? {};
}

describe('drift classifier properties', () => {
  it('a surface diffed against itself has no drift', () => {
    fc.assert(
      fc.property(toolsArb, (tools) => {
        expect(diff(tools, tools)).toEqual([]);
      }),
      FC_PARAMS
    );
  });

  it('key order and required order produce no drift', () => {
    fc.assert(
      fc.property(toolsArb, (tools) => {
        expect(
          diff(
            tools,
            tools.map((t) => reorder(t) as Tool)
          )
        ).toEqual([]);
      }),
      FC_PARAMS
    );
  });

  it('description formatting produces no drift where descriptions are compared by node', () => {
    fc.assert(
      fc.property(toolsArb, (tools) => {
        expect(
          diff(
            tools,
            tools.map((t) => reformatDescriptions(t) as Tool)
          )
        ).toEqual([]);
      }),
      FC_PARAMS
    );
  });

  // Known gap (found by the property above): anyOf/oneOf/allOf and unmodelled keywords such as
  // `not` are compared as raw JSON, so a formatting-only edit of a description inside them is
  // `breaking_schema_change` and fails CI by default. Asserted as it is today; when fixed, this
  // test turns red: flip it to expect no drift.
  it.each([
    ['anyOf', (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: 'number' }] })],
    ['oneOf', (s: JsonSchema): JsonSchema => ({ oneOf: [s, { type: 'number' }] })],
    ['allOf', (s: JsonSchema): JsonSchema => ({ allOf: [s] })],
    ['not', (s: JsonSchema): JsonSchema => ({ type: 'string', not: s })],
  ])('formatting a description inside %s is reported as breaking [known gap]', (_, wrap) => {
    const v = (description: string): Tool => ({
      name: 'a',
      inputSchema: {
        type: 'object',
        properties: { x: wrap({ type: 'string', description }) },
      },
    });
    expect(diff([v('search records')], [v(' search \t records\r\n')]).map((c) => c.class)).toEqual([
      'breaking_schema_change',
    ]);
  });

  it('a removed tool is tool_removed and an added one is tool_added', () => {
    fc.assert(
      fc.property(toolsArb, toolArb, (tools, extra) => {
        fc.pre(!tools.some((t) => t.name === extra.name));
        const removed = diff([...tools, extra], tools);
        expect(removed.map((c) => [c.tool, c.class])).toEqual([[extra.name, 'tool_removed']]);
        const added = diff(tools, [...tools, extra]);
        expect(added.map((c) => [c.tool, c.class])).toEqual([[extra.name, 'tool_added']]);
      }),
      FC_PARAMS
    );
  });

  it('a new required field, at any depth through properties, is breaking', () => {
    fc.assert(
      fc.property(toolWithNewFieldArb, ({ tool, path, name, field }) => {
        const schema = tool.inputSchema as JsonSchema;
        fc.pre(!Object.hasOwn(declared(schema, path), name));
        const after = { ...tool, inputSchema: withField(schema, path, name, field, true) };
        const changes = diff([tool], [after]);
        expect(changes.some((c) => c.class === 'breaking_schema_change')).toBe(true);
      }),
      FC_PARAMS
    );
  });

  it('a new optional field, at any depth through properties, is input_property_added only', () => {
    fc.assert(
      fc.property(toolWithNewFieldArb, ({ tool, path, name, field }) => {
        const schema = tool.inputSchema as JsonSchema;
        fc.pre(!Object.hasOwn(declared(schema, path), name));
        const after = { ...tool, inputSchema: withField(schema, path, name, field, false) };
        const changes = diff([tool], [after]);
        expect(changes.map((c) => c.class)).toEqual(['input_property_added']);
      }),
      FC_PARAMS
    );
  });

  // Known gap (found in review of this property): descriptions that differ only in lone
  // surrogates hash the same, because UTF-8 encoding turns every lone surrogate into U+FFFD.
  // `descriptionArb` has no lone surrogates, so the property below does not cover this case.
  // Asserted as it is today; when fixed, this test turns red: flip it to expect a change.
  it('a description change between lone surrogates is silent [known gap]', () => {
    const tool = (description: string): Tool => ({
      name: 'a',
      description,
      inputSchema: { type: 'object', properties: {} },
    });
    expect(canonicalizeDescription('x\uD800')).not.toBe(canonicalizeDescription('x\uDC00'));
    expect(diff([tool('x\uD800')], [tool('x\uDC00')])).toEqual([]);
  });

  it('a changed tool description is never silent', () => {
    fc.assert(
      fc.property(toolArb, descriptionArb, (tool, text) => {
        fc.pre(canonicalizeDescription(text) !== canonicalizeDescription(tool.description));
        const changes = diff([tool], [{ ...tool, description: text }]);
        expect(changes.map((c) => c.class)).toContain('description_changed');
      }),
      FC_PARAMS
    );
  });

  it('a changed parameter description is never silent', () => {
    fc.assert(
      fc.property(toolArb, identArb, descriptionArb, descriptionArb, (tool, name, a, b) => {
        fc.pre(canonicalizeDescription(a) !== canonicalizeDescription(b));
        const schema = tool.inputSchema as JsonSchema;
        fc.pre(!Object.hasOwn(declared(schema, []), name));
        const v = (description: string) => ({
          ...tool,
          inputSchema: withField(schema, [], name, { type: 'string', description }, false),
        });
        const changes = diff([v(a)], [v(b)]);
        expect(changes.length).toBeGreaterThan(0);
        expect(changes.every((c) => BREAKING.has(c.class))).toBe(true);
      }),
      FC_PARAMS
    );
  });

  it('classification is deterministic: same input pair, same changes in the same order', () => {
    fc.assert(
      fc.property(toolsArb, toolsArb, (before, after) => {
        const first = diff(before, after);
        const second = diff(structuredClone(before), structuredClone(after));
        expect(second).toEqual(first);
      }),
      FC_PARAMS
    );
  });
});
