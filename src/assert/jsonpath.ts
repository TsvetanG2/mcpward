/**
 * JSONPath assertions for behavioral tests.
 *
 * A minimal JSONPath implementation supporting:
 * - Property access: $.foo.bar
 * - Array indexing: $.items[0]
 * - Combined: $.content[0].type
 *
 * This is intentionally simple and covers the use cases in mcpward.yaml suites.
 */

/**
 * Evaluates a JSONPath expression against a value.
 *
 * @param path - JSONPath expression starting with $
 * @param value - The value to query
 * @returns The value at the path, or undefined if not found
 */
export function evaluateJsonPath(path: string, value: unknown): unknown {
  if (!path.startsWith('$')) {
    throw new Error(`JSONPath must start with $, got: ${path}`);
  }

  // Remove the leading $ and split into segments
  const pathWithoutRoot = path.slice(1);
  if (pathWithoutRoot === '' || pathWithoutRoot === '.') {
    return value;
  }

  const segments = parsePathSegments(pathWithoutRoot);
  let current: unknown = value;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (segment.type === 'property') {
      if (typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment.name];
    } else if (segment.type === 'index') {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment.index];
    }
  }

  return current;
}

interface PropertySegment {
  type: 'property';
  name: string;
}

interface IndexSegment {
  type: 'index';
  index: number;
}

type PathSegment = PropertySegment | IndexSegment;

/**
 * Parses a JSONPath (without the leading $) into segments.
 * Supports: .foo, [0], .foo[0], .foo.bar[0].baz
 */
function parsePathSegments(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let i = 0;

  while (i < path.length) {
    // Skip leading dot
    if (path[i] === '.') {
      i++;
    }

    // Parse property name
    if (i < path.length && path[i] !== '[') {
      let name = '';
      while (i < path.length && path[i] !== '.' && path[i] !== '[') {
        name += path[i];
        i++;
      }
      if (name) {
        segments.push({ type: 'property', name });
      }
    }

    // Parse array index
    if (i < path.length && path[i] === '[') {
      i++; // skip [
      let indexStr = '';
      while (i < path.length && path[i] !== ']') {
        indexStr += path[i];
        i++;
      }
      i++; // skip ]

      const index = parseInt(indexStr, 10);
      if (isNaN(index)) {
        throw new Error(`Invalid array index: ${indexStr}`);
      }
      segments.push({ type: 'index', index });
    }
  }

  return segments;
}

/**
 * Asserts that a JSONPath expression evaluates to an expected value.
 */
export interface JsonPathAssertion {
  path: string;
  expected: unknown;
}

/**
 * Evaluates multiple JSONPath assertions.
 *
 * @returns Array of failures (path -> actual vs expected)
 */
export function assertJsonPaths(
  assertions: Record<string, unknown>,
  value: unknown
): { path: string; expected: unknown; actual: unknown }[] {
  const failures: { path: string; expected: unknown; actual: unknown }[] = [];

  for (const [path, expected] of Object.entries(assertions)) {
    const actual = evaluateJsonPath(path, value);
    if (!deepEquals(actual, expected)) {
      failures.push({ path, expected, actual });
    }
  }

  return failures;
}

/**
 * Simple deep equality check.
 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, i) => deepEquals(item, b[i]));
    }

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);

    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEquals(aObj[key], bObj[key]));
  }

  return false;
}
