/**
 * Tests for canonicalization functions.
 *
 * CRITICAL: Verify that canonicalization does NOT remove zero-width
 * or bidi characters - those must be visible to security checks.
 */

import { describe, test, expect } from 'vitest';
import {
  canonicalizeDescription,
  canonicalizeSchema,
  canonicalJson,
} from '../../src/surface/canonical.js';
import type { JsonSchema } from '../../src/surface/types.js';

describe('canonicalizeDescription', () => {
  test('normalizes Unicode to NFC', () => {
    // NFD form: e + combining acute accent
    const nfd = 'Cafe\u0301'; // Café in NFD
    const nfc = 'Café'; // Café in NFC

    const result = canonicalizeDescription(nfd);
    expect(result).toBe(nfc);
    expect(result.normalize('NFC')).toBe(result); // Already NFC
  });

  test('normalizes \\r\\n to \\n', () => {
    const text = 'Line 1\r\nLine 2\r\nLine 3';
    const result = canonicalizeDescription(text);
    expect(result).toBe('Line 1\nLine 2\nLine 3');
  });

  test('normalizes \\r to \\n', () => {
    const text = 'Line 1\rLine 2\rLine 3';
    const result = canonicalizeDescription(text);
    expect(result).toBe('Line 1\nLine 2\nLine 3');
  });

  test('trims leading and trailing whitespace', () => {
    const text = '  \n  Some text  \n  ';
    const result = canonicalizeDescription(text);
    expect(result).toBe('Some text');
  });

  test('collapses runs of spaces to single space', () => {
    const text = 'Multiple    spaces     here';
    const result = canonicalizeDescription(text);
    expect(result).toBe('Multiple spaces here');
  });

  test('collapses runs of tabs to single space', () => {
    const text = 'Multiple\t\t\ttabs\t\there';
    const result = canonicalizeDescription(text);
    expect(result).toBe('Multiple tabs here');
  });

  test('preserves blank lines between paragraphs', () => {
    const text = 'Paragraph 1\n\nParagraph 2\n\n\nParagraph 3';
    const result = canonicalizeDescription(text);
    // Each paragraph trimmed, blank lines preserved
    expect(result).toBe('Paragraph 1\n\nParagraph 2\n\n\nParagraph 3');
  });

  test('CRITICAL: does NOT remove zero-width characters', () => {
    // Zero-width space (U+200B)
    const text = 'Test\u200B text';
    const result = canonicalizeDescription(text);

    // Zero-width should still be present
    expect(result).toContain('\u200B');
    expect(result).toBe('Test\u200B text');
  });

  test('CRITICAL: does NOT remove bidi override characters', () => {
    // Right-to-left override (U+202E)
    const text = 'Test\u202E text';
    const result = canonicalizeDescription(text);

    // Bidi character should still be present
    expect(result).toContain('\u202E');
    expect(result).toBe('Test\u202E text');
  });

  test('handles empty string', () => {
    expect(canonicalizeDescription('')).toBe('');
  });

  test('handles undefined', () => {
    expect(canonicalizeDescription(undefined)).toBe('');
  });

  test('combined normalization', () => {
    // NFD + \r\n + extra spaces + zero-width
    const text = '  Cafe\u0301\u200B  test  \r\n  line 2  ';
    const result = canonicalizeDescription(text);

    expect(result).toBe('Café\u200B test\nline 2');
    expect(result).toContain('\u200B'); // Zero-width preserved
  });
});

describe('canonicalizeSchema', () => {
  test('sorts object keys', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        z: { type: 'string' },
        a: { type: 'number' },
        m: { type: 'boolean' },
      },
    };

    const result = canonicalizeSchema(schema);
    const keys = Object.keys(result?.properties ?? {});

    expect(keys).toEqual(['a', 'm', 'z']); // Alphabetically sorted
  });

  test('sorts required array', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {},
      required: ['z', 'a', 'm'],
    };

    const result = canonicalizeSchema(schema);

    expect(result?.required).toEqual(['a', 'm', 'z']);
  });

  test('preserves array order for non-required arrays', () => {
    const schema: JsonSchema = {
      type: 'object',
      enum: ['c', 'a', 'b'], // Enum order may be meaningful
      anyOf: [{ type: 'string' }, { type: 'number' }], // anyOf order may matter
    };

    const result = canonicalizeSchema(schema) as JsonSchema;

    // Enum and anyOf order preserved
    expect(result.enum).toEqual(['c', 'a', 'b']);
    expect(result.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  test('drops undefined values', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        name: { type: 'string', default: undefined },
      },
      description: undefined,
    };

    const result = canonicalizeSchema(schema) as JsonSchema;

    // undefined fields dropped
    expect(result.description).toBeUndefined();
    expect((result.properties?.name as JsonSchema).default).toBeUndefined();
  });

  test('preserves null values', () => {
    const schema: JsonSchema = {
      type: 'object',
      default: null,
      properties: {
        value: { type: 'string', default: null },
      },
    };

    const result = canonicalizeSchema(schema) as JsonSchema;

    // null is valid JSON, must be preserved
    expect(result.default).toBe(null);
    expect((result.properties?.value as JsonSchema).default).toBe(null);
  });

  test('normalizes string values to NFC', () => {
    const schema: JsonSchema = {
      type: 'object',
      title: 'Cafe\u0301', // NFD
      description: 'Test cafe\u0301', // NFD
      enum: ['value1\u0301', 'value2'], // NFD in enum
    };

    const result = canonicalizeSchema(schema) as JsonSchema;

    expect(result.title).toBe('Café'); // NFC
    expect(result.description).toBe('Test café'); // NFC
    expect((result.enum as string[] | undefined)?.[0]).toBe('value1\u0301'.normalize('NFC')); // NFC
  });

  test('handles nested objects recursively', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            z: { type: 'string' },
            a: { type: 'number' },
          },
        },
      },
    };

    const result = canonicalizeSchema(schema) as JsonSchema;
    const nestedProps = (result.properties?.nested as JsonSchema).properties;
    const nestedKeys = Object.keys(nestedProps ?? {});

    // Nested keys also sorted
    expect(nestedKeys).toEqual(['a', 'z']);
  });

  test('throws on exceeding max depth', () => {
    // Create a deeply nested schema (65+ levels)
    let schema: JsonSchema = { type: 'string' };
    for (let i = 0; i < 70; i++) {
      schema = {
        type: 'object',
        properties: { nested: schema },
      };
    }

    expect(() => canonicalizeSchema(schema)).toThrow(/maximum depth/);
  });

  test('throws on cycles', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {},
    };

    // Create a cycle
    (schema.properties as Record<string, unknown>).self = schema;

    expect(() => canonicalizeSchema(schema)).toThrow(/cycle/);
  });

  test('handles null input', () => {
    expect(canonicalizeSchema(null)).toBe(null);
  });

  test('combined normalization', () => {
    const schema: JsonSchema = {
      properties: {
        z: { type: 'string' },
        a: { type: 'number' },
      },
      type: 'object',
      required: ['z', 'a'],
      title: 'Cafe\u0301', // NFD
      default: undefined, // Should be dropped
      nullable: null, // Should be preserved
    };

    const result = canonicalizeSchema(schema) as JsonSchema;

    // Keys sorted
    expect(Object.keys(result)).toEqual([
      'nullable',
      'properties',
      'required',
      'title',
      'type',
    ]);

    // Properties sorted
    expect(Object.keys(result.properties ?? {})).toEqual(['a', 'z']);

    // Required sorted
    expect(result.required).toEqual(['a', 'z']);

    // Title normalized
    expect(result.title).toBe('Café');

    // undefined dropped
    expect(result.default).toBeUndefined();

    // null preserved
    expect(result.nullable).toBe(null);
  });
});

describe('canonicalJson', () => {
  test('sorts object keys', () => {
    const obj = { z: 1, a: 2, m: 3 };
    const result = canonicalJson(obj);

    // Keys sorted in JSON output
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  test('handles nested objects', () => {
    const obj = {
      z: { y: 1, x: 2 },
      a: { b: 3, a: 4 },
    };
    const result = canonicalJson(obj);

    expect(result).toBe('{"a":{"a":4,"b":3},"z":{"x":2,"y":1}}');
  });

  test('preserves array order', () => {
    const obj = { items: [3, 1, 2] };
    const result = canonicalJson(obj);

    expect(result).toBe('{"items":[3,1,2]}');
  });

  test('drops undefined values', () => {
    const obj = { a: 1, b: undefined, c: 3 };
    const result = canonicalJson(obj);

    expect(result).toBe('{"a":1,"c":3}');
  });

  test('preserves null values', () => {
    const obj = { a: 1, b: null, c: 3 };
    const result = canonicalJson(obj);

    expect(result).toBe('{"a":1,"b":null,"c":3}');
  });
});

describe('canonical forms keep server keys named __proto__', () => {
  test('canonicalJson does not drop or merge a "__proto__" key', async () => {
    const { canonicalJson } = await import('../../src/surface/canonical.js');
    const withProto = JSON.parse('{"__proto__":{"v":1},"a":1}') as unknown;
    expect(canonicalJson(withProto)).toBe('{"__proto__":{"v":1},"a":1}');
    expect(canonicalJson(withProto)).not.toBe(canonicalJson({ a: 1 }));
  });
});

describe('edge trimming is ASCII-only (canonicalization v2)', () => {
  test.each([
    ['leading U+FEFF', '\uFEFFRead a file'],
    ['trailing U+FEFF', 'Read a file\uFEFF'],
    ['leading NBSP', '\u00A0Read a file'],
    ['trailing U+2028', 'Read a file\u2028'],
    ['FEFF at the edge of an inner line', 'Read a file\n\uFEFFthen stop'],
  ])('%s is preserved, so it shows up as drift', (_label, text) => {
    expect(canonicalizeDescription(text)).not.toBe(canonicalizeDescription(text.replace(/[\uFEFF\u00A0\u2028]/g, '')));
  });

  test('ASCII spaces, tabs and newlines at the edges are still trimmed', () => {
    expect(canonicalizeDescription(' \t Read a file \n ')).toBe('Read a file');
  });
});
