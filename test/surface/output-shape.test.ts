/**
 * Output shape inference + diff unit tests (M3).
 *
 * Pure logic as truth tables: inference/merge, result extraction, the side-effect
 * policy (decideSampling), and the consumer-side breaking/non-breaking classifier.
 */

import { describe, it, expect } from 'vitest';
import {
  emptyShape,
  observe,
  extractOutputValue,
  inferShape,
  decideSampling,
  diffOutputShapes,
  type InferredOutputShape,
  type OutputSamplingConfig,
} from '../../src/surface/output-shape.js';
import type { Tool } from '../../src/checks/schema.js';

const structured = (value: Record<string, unknown>) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
});

function infer(values: Record<string, unknown>[]): InferredOutputShape {
  const shape = inferShape(values.map(structured));
  if (!shape) throw new Error('expected a shape');
  return shape;
}

describe('observe / inferShape', () => {
  it('ignores values, keeps structure', () => {
    const a = infer([{ ts: '2026-01-01', n: 1 }]);
    const b = infer([{ ts: '2099-12-31', n: 999 }]);
    expect(a.shape).toEqual(b.shape);
  });

  it('marks a field seen in 2 of 3 samples as optional, not missing', () => {
    const s = infer([{ a: 1, note: 'x' }, { a: 2 }, { a: 3, note: 'y' }]);
    expect(s.samples).toBe(3);
    expect(s.shape.objectCount).toBe(3);
    expect(s.shape.properties?.note?.seen).toBe(2);
    expect(s.shape.properties?.a?.seen).toBe(3);
  });

  it('merges null with a concrete type instead of encoding null', () => {
    const s = infer([{ cursor: null }, { cursor: 'c1' }]);
    expect(s.shape.properties?.cursor?.shape.types).toEqual(['null', 'string']);
  });

  it('merges array element shapes and tolerates empty arrays', () => {
    const s = infer([{ items: [] }, { items: [{ id: 1 }, { id: 2, extra: true }] }]);
    const items = s.shape.properties?.items?.shape.items;
    expect(items?.types).toEqual(['object']);
    expect(items?.properties?.extra?.seen).toBe(1);
  });

  it('skips isError results', () => {
    const shape = inferShape([{ isError: true, content: [] }, structured({ a: 1 })]);
    expect(shape?.samples).toBe(1);
  });

  it('returns null when every sample is an error', () => {
    expect(inferShape([{ isError: true, content: [] }])).toBeNull();
  });

  it('rejects inconsistent output kinds across samples', () => {
    expect(() =>
      inferShape([structured({ a: 1 }), { content: [{ type: 'text', text: 'plain' }] }])
    ).toThrow(/inconsistent output kind/);
  });

  it('is depth-limited against hostile nesting', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { d: deep };
    expect(() => observe(emptyShape(), deep)).toThrow(/maximum depth/);
  });
});

describe('extractOutputValue', () => {
  it('prefers structuredContent', () => {
    expect(extractOutputValue(structured({ a: 1 }))?.source).toBe('structured');
  });

  it('parses a single JSON text block', () => {
    const r = extractOutputValue({ content: [{ type: 'text', text: ' {"a": [1]} ' }] });
    expect(r).toEqual({ source: 'json-text', value: { a: [1] } });
  });

  it('falls back to block kinds for free text — never the text itself', () => {
    const r = extractOutputValue({ content: [{ type: 'text', text: 'hello 123' }] });
    expect(r).toEqual({ source: 'content', value: { text: true } });
  });

  it('text → image content is a breaking change, not an identical shape', () => {
    const base = inferShape([{ content: [{ type: 'text', text: 'a' }] }]);
    const curr = inferShape([{ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }]);
    if (!base || !curr) throw new Error('expected shapes');
    const changes = diffOutputShapes('t', base, curr);
    expect(changes.map((c) => c.class)).toContain('breaking_output_shape_change');
    expect(changes.map((c) => c.message).join(' ')).toContain('$.text was removed');
  });
});

describe('server-controlled keys that collide with Object.prototype', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    '"%s" is an ordinary field: inferred and diffed',
    (key) => {
      const value = JSON.parse(`{"${key}": 1, "a": 1}`) as Record<string, unknown>;
      const base = infer([value]);
      expect(Object.keys(base.shape.properties ?? {})).toEqual([key, 'a']);
      expect(diffOutputShapes('t', base, infer([value]))).toEqual([]);

      // Removing the field is detected, adding it is detected
      expect(diffOutputShapes('t', base, infer([{ a: 1 }])).map((c) => c.class)).toEqual([
        'breaking_output_shape_change',
      ]);
      expect(diffOutputShapes('t', infer([{ a: 1 }]), base).map((c) => c.class)).toEqual([
        'nonbreaking_output_shape_change',
      ]);
    }
  );
});

describe('decideSampling (side-effect policy truth table)', () => {
  const cfg = (over: Partial<OutputSamplingConfig> = {}): OutputSamplingConfig => ({
    shape_samples: 3,
    call_readonly: true,
    tools: [],
    ...over,
  });
  const tool = (annotations: Tool['annotations'], required?: string[]): Tool =>
    ({
      name: 't',
      description: 'd',
      inputSchema: { type: 'object', properties: {}, ...(required ? { required } : {}) },
      annotations,
    }) as Tool;

  it.each([
    ['no annotations', undefined, undefined, false, 'refused'],
    ['readOnlyHint false', { readOnlyHint: false }, undefined, false, 'refused'],
    ['destructive', { destructiveHint: true }, undefined, false, 'refused'],
    [
      'readOnly + destructive (contradiction)',
      { readOnlyHint: true, destructiveHint: true },
      undefined,
      false,
      'refused',
    ],
    ['readOnly, required args', { readOnlyHint: true }, ['id'], false, 'skipped'],
    ['readOnly, no args', { readOnlyHint: true }, undefined, true, undefined],
  ] as const)('%s', (_label, annotations, required, shouldCall, noteStatus) => {
    const d = decideSampling(tool(annotations, required ? [...required] : undefined), cfg());
    expect(d.call).toBe(shouldCall);
    if (!d.call) expect(d.note.status).toBe(noteStatus);
  });

  it('refuses readOnly tools when call_readonly is off', () => {
    expect(decideSampling(tool({ readOnlyHint: true }), cfg({ call_readonly: false })).call).toBe(
      false
    );
  });

  it('allowlist overrides annotations and supplies args', () => {
    const d = decideSampling(
      tool({ destructiveHint: true }, ['id']),
      cfg({ tools: [{ name: 't', args: { id: 'x' } }] })
    );
    expect(d).toEqual({ call: true, args: { id: 'x' } });
  });
});

describe('diffOutputShapes (consumer-side classifier)', () => {
  const classes = (base: Record<string, unknown>[], curr: Record<string, unknown>[]) =>
    diffOutputShapes('t', infer(base), infer(curr)).map((c) => [c.class, c.severity]);

  it('identical structure with different values → no change', () => {
    expect(classes([{ a: 1, b: 'x' }], [{ a: 2, b: 'y' }])).toEqual([]);
  });

  it('always-present field removed → breaking, medium', () => {
    expect(classes([{ a: 1, b: 1 }], [{ a: 1 }])).toEqual([
      ['breaking_output_shape_change', 'medium'],
    ]);
  });

  it('optional field not observed → non-breaking, low', () => {
    expect(classes([{ a: 1, b: 1 }, { a: 1 }], [{ a: 1 }, { a: 2 }])).toEqual([
      ['nonbreaking_output_shape_change', 'low'],
    ]);
  });

  it('field added → non-breaking, low', () => {
    expect(classes([{ a: 1 }], [{ a: 1, b: 2 }])).toEqual([
      ['nonbreaking_output_shape_change', 'low'],
    ]);
  });

  it('type changed (object → string) → breaking', () => {
    expect(classes([{ o: { id: 1 } }], [{ o: 'x' }])).toEqual([
      ['breaking_output_shape_change', 'medium'],
    ]);
  });

  it('new type appears (string → string|null) → breaking', () => {
    expect(classes([{ a: 'x' }, { a: 'y' }], [{ a: 'x' }, { a: null }])).toEqual([
      ['breaking_output_shape_change', 'medium'],
    ]);
  });

  it('type disappears (string|null → string) → non-breaking', () => {
    expect(classes([{ a: 'x' }, { a: null }], [{ a: 'x' }, { a: 'y' }])).toEqual([
      ['nonbreaking_output_shape_change', 'low'],
    ]);
  });

  it('always-present field became optional → breaking', () => {
    expect(
      classes(
        [
          { a: 1, b: 1 },
          { a: 1, b: 1 },
        ],
        [{ a: 1, b: 1 }, { a: 1 }]
      )
    ).toEqual([['breaking_output_shape_change', 'medium']]);
  });

  it('recurses into nested objects and array items', () => {
    const changes = diffOutputShapes(
      't',
      infer([{ list: [{ id: 1, name: 'a' }] }]),
      infer([{ list: [{ id: 1 }] }])
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.message).toContain('$.list[].name');
  });

  it('output kind change → single breaking finding', () => {
    const base = infer([{ a: 1 }]);
    const curr = inferShape([{ content: [{ type: 'text', text: 'plain' }] }]);
    if (!curr) throw new Error('expected a shape');
    const changes = diffOutputShapes('t', base, curr);
    expect(changes.map((c) => c.class)).toEqual(['breaking_output_shape_change']);
    expect(changes[0]?.message).toContain('format changed');
  });

  it('records sample counts in every message', () => {
    const [change] = diffOutputShapes('t', infer([{ a: 1 }, { a: 1 }]), infer([{}]));
    expect(change?.message).toContain('baseline 2 sample(s), current 1 sample(s)');
  });
});
