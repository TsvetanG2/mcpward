/**
 * Hostile input: the server under test is untrusted, so deep nesting, `$ref` cycles, very long
 * strings and unusual unicode must never crash a check and must finish in bounded time.
 * Seed and run count: see `FC_PARAMS` in ./arbitraries.ts.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { checkToolSecurity, runSecurityChecks } from '../../src/checks/security.js';
import { captureToolSurface } from '../../src/surface/capture.js';
import { diffSurfaces } from '../../src/surface/diff.js';
import type { McpConnection } from '../../src/client/connect.js';
import type { JsonSchema } from '../../src/surface/types.js';
import type { Tool } from '../../src/checks/schema.js';
import { FC_PARAMS, inputSchemaArb, surfaceOf } from './arbitraries.js';

/** Per-input budget. Generous: CI runners are slow, and the point is "not quadratic or stuck". */
const BUDGET_MS = 2000;

/** Strings a server may send: any code units (lone surrogates too), long runs, tag characters. */
const hostileText = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 200 }),
  fc
    .tuple(
      fc.constantFrom('a', ' ', '​', '\u{E0041}', '\u{1F3F4}', '\r\n', '\uD800'),
      fc.integer({ min: 1, max: 20_000 })
    )
    .map(([unit, n]) => unit.repeat(n))
);

/** A chain of `depth` nested objects, each with a described property. */
function nested(depth: number, description: string): JsonSchema {
  let schema: JsonSchema = { type: 'string', description };
  for (let i = 0; i < depth; i++) {
    schema = { type: 'object', description, properties: { [`p${i}`]: schema } };
  }
  return schema;
}

/** `$ref` chains and cycles inside `$defs`, reached from the root. */
const refCycleArb = fc.integer({ min: 1, max: 50 }).map((n): JsonSchema => {
  const defs: Record<string, JsonSchema> = {};
  for (let i = 0; i < n; i++) {
    defs[`d${i}`] = { type: 'object', properties: { next: { $ref: `#/$defs/d${(i + 1) % n}` } } };
  }
  return { type: 'object', properties: { start: { $ref: '#/$defs/d0' } }, $defs: defs };
});

const hostileSchemaArb: fc.Arbitrary<JsonSchema> = fc.oneof(
  inputSchemaArb,
  refCycleArb,
  fc.tuple(fc.integer({ min: 1, max: 300 }), hostileText).map(([d, text]) => nested(d, text))
);

const hostileToolArb: fc.Arbitrary<Tool> = fc.record({
  name: hostileText,
  description: hostileText,
  inputSchema: hostileSchemaArb,
});

function timed<T>(fn: () => T): T {
  const start = performance.now();
  const value = fn();
  expect(performance.now() - start).toBeLessThan(BUDGET_MS);
  return value;
}

/** Capture rejects schemas deeper than its limit, by design; anything else must succeed. */
function captureOrReject(tool: Tool) {
  try {
    return captureToolSurface(tool);
  } catch (err) {
    expect((err as Error).message).toMatch(/untrusted input protection/);
    return undefined;
  }
}

describe('hostile input properties', () => {
  it('the security checks never throw and finish in bounded time', () => {
    fc.assert(
      fc.property(hostileToolArb, (tool) => {
        timed(() => checkToolSecurity(tool));
      }),
      { ...FC_PARAMS, numRuns: Math.min(FC_PARAMS.numRuns ?? 100, 50) }
    );
  });

  it('capture accepts or rejects with its depth/cycle error, and diff never throws', () => {
    fc.assert(
      fc.property(hostileToolArb, hostileToolArb, (a, b) => {
        const before = { ...a, name: 't' };
        const after = { ...b, name: 't' };
        if (!captureOrReject(before) || !captureOrReject(after)) return;
        timed(() => diffSurfaces(surfaceOf([before]), surfaceOf([after])));
      }),
      { ...FC_PARAMS, numRuns: Math.min(FC_PARAMS.numRuns ?? 100, 50) }
    );
  });

  // --- Known gaps found while writing these properties. Each asserts today's crash; when the
  // crash is fixed the test turns red: flip it to expect no throw. ---

  const tags = (n: number) => '\u{1F3F4}' + String.fromCodePoint(0xe0041).repeat(n);

  it('a black flag followed by 200,000 tag characters crashes the security check [known gap]', () => {
    // findSuspiciousUnicode spreads the whole tag run into String.fromCharCode(...)
    expect(() => checkToolSecurity({ name: 't', description: tags(200_000) })).toThrow(RangeError);
  });

  it('one tool with 150,000 findings crashes the security scan [known gap]', async () => {
    // runSecurityChecks spreads one tool's results into results.push(...)
    const properties = Object.fromEntries(
      Array.from({ length: 150_000 }, (_, i) => [`p${i}`, { description: 'x​y' }])
    );
    const tool = { name: 't', inputSchema: { type: 'object', properties } };
    const connection = {
      client: { listTools: async () => ({ tools: [tool] }) },
    } as unknown as McpConnection;
    await expect(runSecurityChecks({ connection })).rejects.toThrow(RangeError);
  });

  it('150,000 new input fields on one tool crash the drift diff [known gap]', () => {
    // diffTool spreads every input schema change into changes.push(...)
    const properties = Object.fromEntries(
      Array.from({ length: 150_000 }, (_, i) => [`p${i}`, { type: 'string' }])
    );
    const v = (props: Record<string, unknown>): Tool => ({
      name: 't',
      inputSchema: { type: 'object', properties: props },
    });
    expect(() => diffSurfaces(surfaceOf([v({})]), surfaceOf([v(properties)]))).toThrow(RangeError);
  });
});
