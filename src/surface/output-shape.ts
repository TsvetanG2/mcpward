/**
 * Output shape inference and drift (M3, #20).
 *
 * Input drift trips the client at the call site; output drift is silent until something
 * downstream chokes. Many servers declare no `outputSchema`, so we infer a structural
 * shape from real responses and diff THAT.
 *
 * Rules that keep this from crying wolf:
 * - Structure only: field presence, JSON type, nesting. NEVER values — a response that
 *   contains today's timestamp is not drift.
 * - Never trust a single response: shapes are merged across `shape_samples` calls. A field
 *   seen in 2 of 3 samples is optional, not missing; a field null in one sample has type
 *   `null | string`, not `null`.
 * - Every finding records the sample counts so a reviewer can judge confidence.
 *
 * Side-effect rule (the one that must never regress): this module CALLS TOOLS. It only
 * calls a tool that is explicitly allowlisted in config, or that the server annotates
 * `readOnlyHint: true` (and not `destructiveHint: true`). Everything else is refused.
 * A testing tool that mutates production state is unforgivable.
 *
 * The server is untrusted: inference is depth- and width-limited.
 */

import type { McpConnection } from '../client/connect.js';
import type { Tool } from '../checks/schema.js';
import type { DriftChange, DriftClass } from './types.js';

export type ShapeType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

/** Structural shape of a JSON value, merged across samples. */
export interface ShapeNode {
  /** JSON types observed at this position, sorted. */
  types: ShapeType[];
  /** Number of times an object was observed here (denominator for property optionality). */
  objectCount?: number;
  /** Object properties, when `object` is among `types`. */
  properties?: Record<string, ShapeProperty>;
  /** Merged element shape, when `array` is among `types` and at least one element was seen. */
  items?: ShapeNode;
}

export interface ShapeProperty {
  /** Number of observed objects that contained this property. */
  seen: number;
  shape: ShapeNode;
}

/**
 * Where the inferred value came from:
 * - structured: `structuredContent`
 * - json-text: a single text content block whose text parses as a JSON object/array
 * - content: the content block list itself (shape of `[{type: ...}]`)
 */
export type OutputSource = 'structured' | 'json-text' | 'content';

export interface InferredOutputShape {
  source: OutputSource;
  /** Number of successful samples the shape was inferred from. */
  samples: number;
  shape: ShapeNode;
}

export interface OutputSamplingConfig {
  shape_samples: number;
  call_readonly: boolean;
  tools: { name: string; args: Record<string, unknown> }[];
}

export interface SamplingNote {
  tool: string;
  status: 'refused' | 'skipped' | 'failed' | 'partial';
  reason: string;
}

export interface SamplingResult {
  shapes: Record<string, InferredOutputShape>;
  notes: SamplingNote[];
}

/** Untrusted-input limits. */
const MAX_DEPTH = 64;
const MAX_PROPERTIES = 1000;
const MAX_ARRAY_ITEMS = 100;

function typeOf(value: unknown): ShapeType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
    case 'bigint':
      return 'number';
    case 'string':
      return 'string';
    default:
      return 'object';
  }
}

/** Creates an empty node that has observed nothing yet. */
export function emptyShape(): ShapeNode {
  return { types: [] };
}

/**
 * Folds one observed value into a shape node, in place.
 * Exported for tests; production code goes through `inferShape`.
 */
export function observe(node: ShapeNode, value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) {
    throw new Error(`Output exceeds maximum depth of ${MAX_DEPTH} (untrusted input protection)`);
  }

  const type = typeOf(value);
  if (!node.types.includes(type)) {
    node.types.push(type);
    node.types.sort();
  }

  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length > MAX_PROPERTIES) {
      throw new Error(
        `Output object has ${keys.length} properties, limit is ${MAX_PROPERTIES} (untrusted input protection)`
      );
    }
    node.objectCount = (node.objectCount ?? 0) + 1;
    node.properties ??= {};
    for (const key of keys) {
      const prop = (node.properties[key] ??= { seen: 0, shape: emptyShape() });
      prop.seen += 1;
      observe(prop.shape, obj[key], depth + 1);
    }
  } else if (type === 'array') {
    const arr = value as unknown[];
    for (const item of arr.slice(0, MAX_ARRAY_ITEMS)) {
      node.items ??= emptyShape();
      observe(node.items, item, depth + 1);
    }
  }
}

/**
 * Extracts the value whose shape we track from a tools/call result.
 * Returns null for tool errors (`isError: true`) — an error payload is not the output contract.
 */
export function extractOutputValue(
  result: unknown
): { source: OutputSource; value: unknown } | null {
  if (result === null || typeof result !== 'object') return null;
  const r = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: unknown;
  };
  if (r.isError === true) return null;

  if (r.structuredContent !== undefined && r.structuredContent !== null) {
    return { source: 'structured', value: r.structuredContent };
  }

  const content = Array.isArray(r.content) ? r.content : [];
  if (content.length === 1) {
    const block = content[0] as { type?: unknown; text?: unknown };
    if (block?.type === 'text' && typeof block.text === 'string') {
      const trimmed = block.text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return { source: 'json-text', value: JSON.parse(trimmed) };
        } catch {
          // Not JSON — fall through to the content-list shape
        }
      }
    }
  }

  // Track only the block kinds, never the text: free text is a value, not structure.
  return {
    source: 'content',
    value: content.map((block) => ({
      type:
        typeof (block as { type?: unknown })?.type === 'string'
          ? (block as { type: string }).type
          : 'unknown',
    })),
  };
}

/**
 * Infers a merged shape from several tools/call results.
 * Throws if successful samples disagree on the output source (structured vs text):
 * that is an unstable server, not a shape.
 */
export function inferShape(results: unknown[]): InferredOutputShape | null {
  let source: OutputSource | undefined;
  const shape = emptyShape();
  let samples = 0;

  for (const result of results) {
    const extracted = extractOutputValue(result);
    if (!extracted) continue;
    if (source !== undefined && source !== extracted.source) {
      throw new Error(`inconsistent output kind across samples (${source} vs ${extracted.source})`);
    }
    source = extracted.source;
    observe(shape, extracted.value);
    samples += 1;
  }

  if (source === undefined) return null;
  return { source, samples, shape };
}

/**
 * Decides whether mcpward may call a tool, and with which arguments.
 * Pure function — the side-effect policy lives here and is unit-tested as a truth table.
 */
export function decideSampling(
  tool: Tool,
  cfg: OutputSamplingConfig
): { call: true; args: Record<string, unknown> } | { call: false; note: SamplingNote } {
  const allow = cfg.tools.find((t) => t.name === tool.name);
  if (allow) {
    return { call: true, args: allow.args };
  }

  const readOnly = tool.annotations?.readOnlyHint === true;
  const destructive = tool.annotations?.destructiveHint === true;

  if (!cfg.call_readonly || !readOnly || destructive) {
    return {
      call: false,
      note: {
        tool: tool.name,
        status: 'refused',
        reason: !readOnly
          ? 'not annotated readOnlyHint: true and not in checks.drift.output.tools — mcpward will not call a tool that may have side effects'
          : destructive
            ? 'annotated both readOnlyHint and destructiveHint — contradictory, refusing to call without an explicit allowlist entry'
            : 'call_readonly is disabled and the tool is not in checks.drift.output.tools',
      },
    };
  }

  const required = (tool.inputSchema as { required?: unknown } | undefined)?.required;
  if (Array.isArray(required) && required.length > 0) {
    return {
      call: false,
      note: {
        tool: tool.name,
        status: 'skipped',
        reason: `requires arguments (${required.join(', ')}) — add it to checks.drift.output.tools with args`,
      },
    };
  }

  return { call: true, args: {} };
}

/**
 * Calls eligible tools `shape_samples` times each and infers their output shapes.
 */
export async function sampleOutputShapes(
  connection: McpConnection,
  tools: Tool[],
  cfg: OutputSamplingConfig
): Promise<SamplingResult> {
  const shapes: Record<string, InferredOutputShape> = {};
  const notes: SamplingNote[] = [];
  const toolNames = new Set(tools.map((t) => t.name));

  for (const entry of cfg.tools) {
    if (!toolNames.has(entry.name)) {
      notes.push({
        tool: entry.name,
        status: 'failed',
        reason: 'listed in checks.drift.output.tools but the server does not expose it',
      });
    }
  }

  for (const tool of tools) {
    const decision = decideSampling(tool, cfg);
    if (!decision.call) {
      notes.push(decision.note);
      continue;
    }

    const results: unknown[] = [];
    let errors = 0;
    let lastError = '';
    for (let i = 0; i < cfg.shape_samples; i++) {
      try {
        const result = await connection.callTool({ name: tool.name, arguments: decision.args });
        if ((result as { isError?: boolean })?.isError === true) {
          errors += 1;
          lastError = 'tool returned isError: true';
        } else {
          results.push(result);
        }
      } catch (err) {
        errors += 1;
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    let inferred: InferredOutputShape | null;
    try {
      inferred = inferShape(results);
    } catch (err) {
      notes.push({
        tool: tool.name,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!inferred) {
      notes.push({
        tool: tool.name,
        status: 'failed',
        reason: `no successful sample out of ${cfg.shape_samples} (last error: ${lastError})`,
      });
      continue;
    }

    if (errors > 0) {
      notes.push({
        tool: tool.name,
        status: 'partial',
        reason: `${errors} of ${cfg.shape_samples} samples failed (last error: ${lastError}); shape inferred from ${inferred.samples}`,
      });
    }
    shapes[tool.name] = inferred;
  }

  return { shapes, notes };
}

// ─── Diff ──────────────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<OutputSource, string> = {
  structured: 'structuredContent',
  'json-text': 'JSON text content',
  content: 'content blocks',
};

function isRequired(prop: ShapeProperty, parent: ShapeNode): boolean {
  return prop.seen >= (parent.objectCount ?? 0);
}

/**
 * Compares two inferred output shapes. Pure function.
 *
 * From a CONSUMER's point of view (the opposite of input schemas):
 * - breaking: an always-present field disappears or becomes optional, a field starts
 *   carrying a type the baseline never produced, the output kind changes.
 * - non-breaking: a new field appears, a field stops producing one of its types, an
 *   optional field becomes always-present.
 */
export function diffOutputShapes(
  toolName: string,
  baseline: InferredOutputShape,
  current: InferredOutputShape
): DriftChange[] {
  const changes: DriftChange[] = [];
  const confidence = `baseline ${baseline.samples} sample(s), current ${current.samples} sample(s)`;

  const push = (
    breaking: boolean,
    path: string,
    what: string,
    previous: unknown,
    curr: unknown
  ) => {
    const driftClass: DriftClass = breaking
      ? 'breaking_output_shape_change'
      : 'nonbreaking_output_shape_change';
    changes.push({
      tool: toolName,
      class: driftClass,
      severity: breaking ? 'medium' : 'low',
      message: `Tool "${toolName}" output ${path} ${what} (inferred; ${confidence})`,
      previous,
      current: curr,
    });
  };

  if (baseline.source !== current.source) {
    push(
      true,
      'format',
      `changed from ${SOURCE_LABELS[baseline.source]} to ${SOURCE_LABELS[current.source]}`,
      baseline.source,
      current.source
    );
    return changes;
  }

  const walk = (base: ShapeNode, curr: ShapeNode, path: string): void => {
    const added = curr.types.filter((t) => !base.types.includes(t));
    const removed = base.types.filter((t) => !curr.types.includes(t));

    if (added.length > 0) {
      const overlap = curr.types.some((t) => base.types.includes(t));
      push(
        true,
        path,
        overlap
          ? `now also returns ${added.join(' | ')}`
          : `type changed from ${base.types.join(' | ')} to ${curr.types.join(' | ')}`,
        base.types,
        curr.types
      );
    } else if (removed.length > 0) {
      push(false, path, `no longer returns ${removed.join(' | ')}`, base.types, curr.types);
    }

    // Recurse only where both sides observed the same container type.
    if (base.properties && curr.properties) {
      for (const [key, baseProp] of Object.entries(base.properties)) {
        const currProp = curr.properties[key];
        const childPath = `${path}.${key}`;
        if (!currProp) {
          if (isRequired(baseProp, base)) {
            push(true, childPath, 'was removed', baseProp.shape.types, undefined);
          } else {
            push(
              false,
              childPath,
              'was not observed (was optional)',
              baseProp.shape.types,
              undefined
            );
          }
          continue;
        }
        const wasRequired = isRequired(baseProp, base);
        const nowRequired = isRequired(currProp, curr);
        if (wasRequired && !nowRequired) {
          push(
            true,
            childPath,
            `became optional (present in ${currProp.seen} of ${curr.objectCount} observed objects)`,
            { required: true },
            { required: false }
          );
        } else if (!wasRequired && nowRequired) {
          push(false, childPath, 'became always-present', { required: false }, { required: true });
        }
        walk(baseProp.shape, currProp.shape, childPath);
      }
      for (const key of Object.keys(curr.properties)) {
        if (!(key in base.properties)) {
          push(false, `${path}.${key}`, 'was added', undefined, curr.properties[key]?.shape.types);
        }
      }
    }

    if (base.items && curr.items) {
      walk(base.items, curr.items, `${path}[]`);
    }
  };

  walk(baseline.shape, current.shape, '$');
  return changes;
}
