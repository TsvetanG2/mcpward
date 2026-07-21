/**
 * JSONPath assertion tests
 */

import { describe, it, expect } from 'vitest';
import { evaluateJsonPath, assertJsonPaths } from '../../src/assert/jsonpath.js';

describe('evaluateJsonPath', () => {
  const testData = {
    name: 'test',
    nested: {
      value: 42,
      deep: {
        array: [1, 2, 3],
      },
    },
    items: [
      { type: 'text', content: 'hello' },
      { type: 'image', url: 'https://example.com/img.png' },
    ],
  };

  it('evaluates root path $', () => {
    expect(evaluateJsonPath('$', testData)).toEqual(testData);
  });

  it('evaluates simple property path', () => {
    expect(evaluateJsonPath('$.name', testData)).toBe('test');
  });

  it('evaluates nested property path', () => {
    expect(evaluateJsonPath('$.nested.value', testData)).toBe(42);
  });

  it('evaluates deeply nested property path', () => {
    expect(evaluateJsonPath('$.nested.deep.array', testData)).toEqual([1, 2, 3]);
  });

  it('evaluates array index', () => {
    expect(evaluateJsonPath('$.items[0]', testData)).toEqual({
      type: 'text',
      content: 'hello',
    });
  });

  it('evaluates array index with property', () => {
    expect(evaluateJsonPath('$.items[0].type', testData)).toBe('text');
    expect(evaluateJsonPath('$.items[1].url', testData)).toBe(
      'https://example.com/img.png'
    );
  });

  it('evaluates nested array index', () => {
    expect(evaluateJsonPath('$.nested.deep.array[0]', testData)).toBe(1);
    expect(evaluateJsonPath('$.nested.deep.array[2]', testData)).toBe(3);
  });

  it('returns undefined for non-existent property', () => {
    expect(evaluateJsonPath('$.nonexistent', testData)).toBeUndefined();
    expect(evaluateJsonPath('$.nested.missing', testData)).toBeUndefined();
  });

  it('returns undefined for out-of-bounds array index', () => {
    expect(evaluateJsonPath('$.items[99]', testData)).toBeUndefined();
  });

  it('returns undefined for array index on non-array', () => {
    expect(evaluateJsonPath('$.name[0]', testData)).toBeUndefined();
  });

  it('throws for invalid path not starting with $', () => {
    expect(() => evaluateJsonPath('name', testData)).toThrow();
  });
});

describe('assertJsonPaths', () => {
  const testData = {
    content: [{ type: 'text', text: 'hello' }],
    isError: false,
  };

  it('returns empty array when all assertions pass', () => {
    const assertions = {
      '$.content[0].type': 'text',
      '$.isError': false,
    };
    const failures = assertJsonPaths(assertions, testData);
    expect(failures).toHaveLength(0);
  });

  it('returns failures for mismatched values', () => {
    const assertions = {
      '$.content[0].type': 'image', // Wrong!
      '$.isError': true, // Wrong!
    };
    const failures = assertJsonPaths(assertions, testData);
    expect(failures).toHaveLength(2);

    expect(failures[0]).toEqual({
      path: '$.content[0].type',
      expected: 'image',
      actual: 'text',
    });

    expect(failures[1]).toEqual({
      path: '$.isError',
      expected: true,
      actual: false,
    });
  });

  it('handles nested object equality', () => {
    const assertions = {
      '$.content[0]': { type: 'text', text: 'hello' },
    };
    const failures = assertJsonPaths(assertions, testData);
    expect(failures).toHaveLength(0);
  });

  it('handles array equality', () => {
    const data = { arr: [1, 2, 3] };
    const assertions = {
      '$.arr': [1, 2, 3],
    };
    const failures = assertJsonPaths(assertions, data);
    expect(failures).toHaveLength(0);
  });
});
