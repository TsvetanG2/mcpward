/**
 * Canonicalization for drift detection.
 *
 * CRITICAL REQUIREMENT:
 * Canonicalization is for the drift hash ONLY. The security scan (src/checks/security.ts)
 * must read raw, unmodified bytes to detect zero-width and bidi characters.
 * If canonicalization ever strips those before the security check sees them, mcpward
 * silently stops detecting tool poisoning — a false negative, the worst bug class
 * in this project.
 *
 * Two separate passes over the same string. Never one.
 */

import type { JsonSchema } from './types.js';

/**
 * Maximum depth for schema traversal to prevent stack overflow from untrusted input.
 */
const MAX_SCHEMA_DEPTH = 64;

/**
 * Canonicalizes a tool description for drift detection.
 *
 * Normalizations applied:
 * - Unicode normalization to NFC
 * - Line endings normalized: \r\n and \r → \n
 * - Leading/trailing whitespace trimmed
 * - Runs of spaces/tabs within a line collapsed to single space
 * - Blank-line structure between paragraphs preserved
 *
 * DOES NOT remove zero-width, bidi, or other invisible characters.
 * NFC leaves these intact — verified by tests.
 *
 * @param text - The description text to canonicalize
 * @returns Canonical form of the description
 */
export function canonicalizeDescription(text: string | undefined): string {
  if (!text) return '';

  // Unicode normalization to NFC
  let normalized = text.normalize('NFC');

  // Normalize line endings: \r\n and \r → \n
  normalized = normalized.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split into lines, process each line, then rejoin
  const lines = normalized.split('\n');
  const processedLines = lines.map((line) => {
    // Collapse runs of spaces/tabs within a line to single space
    return line.replace(/[ \t]+/g, ' ').trim();
  });

  // Join lines and trim outer whitespace
  return processedLines.join('\n').trim();
}

/**
 * Canonicalizes a JSON Schema for drift detection.
 *
 * Normalizations applied:
 * - Object keys sorted deterministically (recursively)
 * - Array order preserved EXCEPT for `required` array which is sorted
 * - String values normalized to NFC (descriptions, titles, enum members)
 * - Keys with `undefined` values dropped (undefined is not valid JSON)
 * - `null` values preserved (null IS valid JSON)
 * - Depth-limited and cycle-safe for untrusted input
 *
 * Note on array ordering: `enum` and `anyOf` order may be semantically meaningful,
 * so we preserve source order for all arrays except `required` (which is a set).
 * Do not "helpfully" change this later.
 *
 * @param schema - The schema to canonicalize
 * @returns Canonical form of the schema, or null if input was null
 * @throws Error if schema exceeds max depth or contains cycles
 */
export function canonicalizeSchema(
  schema: JsonSchema | null
): JsonSchema | null {
  if (schema === null) return null;

  const seen = new WeakSet<object>();

  function canonicalizeValue(value: unknown, depth: number): unknown {
    // Depth limit check
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new Error(
        `Schema exceeds maximum depth of ${MAX_SCHEMA_DEPTH} (untrusted input protection)`
      );
    }

    // Handle primitives and null
    if (value === null) return null;
    if (value === undefined) return undefined;
    if (typeof value !== 'object') {
      // Normalize strings to NFC
      if (typeof value === 'string') {
        return value.normalize('NFC');
      }
      return value;
    }

    // Cycle detection
    if (seen.has(value)) {
      throw new Error('Schema contains cycles (untrusted input protection)');
    }
    seen.add(value);

    // Handle arrays
    if (Array.isArray(value)) {
      const result = value.map((item) => canonicalizeValue(item, depth + 1));
      seen.delete(value);
      return result;
    }

    // Handle objects - sort keys recursively
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};

    for (const key of sortedKeys) {
      const val = obj[key];
      // Drop undefined values
      if (val === undefined) continue;

      // Special case: sort the `required` array since it's a set
      if (key === 'required' && Array.isArray(val)) {
        result[key] = [...val].sort();
      } else {
        result[key] = canonicalizeValue(val, depth + 1);
      }
    }

    seen.delete(value);
    return result;
  }

  return canonicalizeValue(schema, 0) as JsonSchema;
}

/**
 * Converts a value to canonical JSON string representation.
 *
 * Used for deterministic serialization of schemas and other JSON values.
 * Keys are sorted recursively.
 *
 * @param value - The value to serialize
 * @returns Canonical JSON string
 */
export function canonicalJson(value: unknown): string {
  function canonicalize(val: unknown): unknown {
    if (val === null || val === undefined) return val;
    if (typeof val !== 'object') return val;

    if (Array.isArray(val)) {
      return val.map(canonicalize);
    }

    const obj = val as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};

    for (const key of sortedKeys) {
      const value = obj[key];
      if (value !== undefined) {
        result[key] = canonicalize(value);
      }
    }

    return result;
  }

  return JSON.stringify(canonicalize(value));
}
