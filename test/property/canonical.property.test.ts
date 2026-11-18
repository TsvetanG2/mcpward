/**
 * Property-based tests for canonicalization (`src/surface/canonical.ts`).
 * Seed and run count: see `FC_PARAMS` in ./arbitraries.ts.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  canonicalizeDescription,
  canonicalizeSchema,
  canonicalJson,
} from '../../src/surface/canonical.js';
import { hashDescription } from '../../src/surface/capture.js';
import { FC_PARAMS, descriptionArb, inputSchemaArb, reformat, reorder } from './arbitraries.js';

/** Any string, including astral characters, lone surrogates and control characters. */
const anyText = fc.oneof(fc.string({ unit: 'binary' }), descriptionArb);

describe('canonicalization properties', () => {
  it('canonicalizing a description twice changes nothing', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const once = canonicalizeDescription(text);
        expect(canonicalizeDescription(once)).toBe(once);
      }),
      FC_PARAMS
    );
  });

  it('canonicalizing a schema twice changes nothing', () => {
    fc.assert(
      fc.property(inputSchemaArb, (schema) => {
        const once = canonicalizeSchema(schema);
        expect(canonicalJson(canonicalizeSchema(once))).toBe(canonicalJson(once));
      }),
      FC_PARAMS
    );
  });

  it('line endings, extra spaces and tabs, and NFD do not change the description hash', () => {
    fc.assert(
      fc.property(descriptionArb, (text) => {
        expect(hashDescription(reformat(text))).toBe(hashDescription(text));
      }),
      FC_PARAMS
    );
  });

  it('key order and required order do not change the canonical schema', () => {
    fc.assert(
      fc.property(inputSchemaArb, (schema) => {
        expect(canonicalJson(canonicalizeSchema(reorder(schema) as typeof schema))).toBe(
          canonicalJson(canonicalizeSchema(schema))
        );
      }),
      FC_PARAMS
    );
  });

  it('invisible characters survive canonicalization (they are the attack, not formatting)', () => {
    const invisible = fc.constantFrom('​', '‍', '‮', '⁠', '﻿', '\u{E0041}');
    fc.assert(
      fc.property(descriptionArb, invisible, fc.nat(), (text, char, at) => {
        const i = at % (text.length + 1);
        const poisoned = text.slice(0, i) + char + text.slice(i);
        expect(canonicalizeDescription(poisoned)).toContain(char);
        expect(hashDescription(poisoned)).not.toBe(hashDescription(text));
      }),
      FC_PARAMS
    );
  });
});
