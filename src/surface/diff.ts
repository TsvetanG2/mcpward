/**
 * Surface diff and classifier.
 *
 * Compares two server surfaces and classifies each change
 * according to the drift truth table (SPEC.md §7.2).
 *
 * Truth table:
 * | Change | Class | Breaking? |
 * |--------|-------|-----------|
 * | In lock, absent now | tool_removed | yes |
 * | Absent in lock, present now | tool_added | no |
 * | descriptionHash changed | description_changed | yes (rug-pull!) |
 * | Added required field / removed field / narrowed type | breaking_schema_change | yes |
 * | Added optional input field on an existing tool | input_property_added | no |
 * | Widened type / loosened constraint | nonbreaking_schema_change | no |
 * | A hint now claims a riskier tool (readOnlyHint true→false, destructiveHint false→true,
 * |   openWorldHint false→true) | annotation_changed | yes |
 * | A hint now claims a safer tool (the reverse of each) | annotation_relaxed | no |
 * | idempotentHint changed, either direction | idempotency_changed | no |
 */

import type {
  ServerSurface,
  ToolSurface,
  DriftChange,
  DriftResult,
  DriftClass,
  DriftSeverity,
  JsonSchema,
} from './types.js';
import { canonicalizeSchema, canonicalJson, canonicalizeDescription } from './canonical.js';
import { diffOutputShapes } from './output-shape.js';
import {
  collectParamDescriptions,
  findInjectionPatterns,
  findSuspiciousUnicode,
  isSchemaResource,
  isSecretField,
  walkParams,
  resolveLocalRefIn,
} from '../checks/heuristics.js';

/**
 * Maps drift classes to default severity levels based on blast radius (M2).
 *
 * CRITICAL: tool_removed is LOW, not HIGH. This will look wrong at first glance.
 * It is the correct call per IMPLEMENTATION.md §M2.1:
 *
 * A removed tool breaks loudly at the call site and gets fixed in minutes.
 * A widened permission (readOnlyHint flip) is silent and may never be noticed.
 * Blast radius, not breakage, determines severity.
 *
 * Severity levels:
 * - high: Changes affecting client security or auto-approval (permission expansion, rug-pull)
 * - medium: Changes breaking loudly at the call site (schema breaks), and new optional input
 *   fields (non-breaking, but an approved tool can now be handed data it never asked for)
 * - low: Visible, expected changes (tool add/remove, widened types, loosened constraints)
 */
function getDefaultSeverity(driftClass: DriftClass): DriftSeverity {
  switch (driftClass) {
    case 'description_changed':
      // Rug-pull vector - the model reads this and makes decisions
      return 'high';

    case 'annotation_changed':
      // A hint now claims a riskier tool (readOnlyHint true→false, ...).
      // Changes what a client auto-approves - silent authority increase.
      return 'high';

    case 'idempotency_changed':
      // idempotentHint changed, either direction: a retry risk, not a data risk.
      return 'medium';

    case 'annotation_relaxed':
      // A hint now claims a safer tool (readOnlyHint false→true, ...). Not breaking, but
      // "I am harmless now" is how a tool gets auto-approved.
      return 'medium';

    case 'breaking_schema_change':
      // New required field, removed field, narrowed type
      // Breaks loudly at the call site, but doesn't affect security
      return 'medium';

    case 'nonbreaking_schema_change':
      // Widened type, loosened constraint
      return 'low';

    case 'input_property_added':
      // Non-breaking for callers, but the post-approval exfiltration shape: an approved tool
      // gains an optional `context` field and a helpful agent fills it with local data.
      // Compatibility and security are separate axes. Escalated to high when the field
      // looks hostile (see suspiciousNewInput).
      return 'medium';

    case 'tool_added':
      // Visible and expected
      return 'low';

    case 'tool_removed':
      // CRITICAL: This is LOW, not HIGH.
      // Breaks loudly and gets fixed immediately. Not a silent security change.
      return 'low';

    case 'breaking_output_shape_change':
      // M3: breaks downstream consumers, not the call site
      return 'medium';

    case 'nonbreaking_output_shape_change':
      return 'low';

    default:
      // Unreachable, but TypeScript doesn't know that
      return 'medium';
  }
}

/**
 * Classifies a type change as widening, narrowing, or unrelated (M2.2).
 *
 * This is a simplified heuristic for common cases. A complete implementation
 * would need full schema structural comparison.
 *
 * Returns:
 * - 'widening': Type became more permissive (breaking: false, severity: low)
 * - 'narrowing': Type became more restrictive (breaking: true, severity: medium)
 * - 'unrelated': Types are incompatible (breaking: true, severity: medium)
 */
function classifyTypeChange(
  baselineType: string | string[] | undefined,
  currentType: string | string[] | undefined
): 'widening' | 'narrowing' | 'unrelated' {
  // Normalize to arrays for union type handling
  const baseTypes = Array.isArray(baselineType) ? baselineType : baselineType ? [baselineType] : [];
  const currTypes = Array.isArray(currentType) ? currentType : currentType ? [currentType] : [];

  // No `type` means ANY type: adding one narrows what is accepted, removing one widens it.
  // (Treating "absent" as an empty set would call `{}` → `{type: string}` a widening.)
  if (baseTypes.length === 0 && currTypes.length > 0) return 'narrowing';
  if (baseTypes.length > 0 && currTypes.length === 0) return 'widening';

  const baseSet = new Set(baseTypes);
  const currSet = new Set(currTypes);

  // Check if current is a superset of baseline (widening: string → string|number)
  const isSuperset = baseTypes.every((t) => currSet.has(t));
  if (isSuperset && currTypes.length > baseTypes.length) {
    return 'widening';
  }

  // Check if current is a subset of baseline (narrowing: string|number → string)
  const isSubset = currTypes.every((t) => baseSet.has(t));
  if (isSubset && currTypes.length < baseTypes.length) {
    return 'narrowing';
  }

  // Check if sets have any overlap
  const hasOverlap = currTypes.some((t) => baseSet.has(t));
  if (!hasOverlap) {
    // Completely different types (string → object)
    return 'unrelated';
  }

  // Partial overlap but not superset/subset - treat as unrelated
  return 'unrelated';
}

/**
 * Compares baseline and current surfaces, returning classified changes.
 * This is a pure function for easy testing.
 */
export function diffSurfaces(baseline: ServerSurface, current: ServerSurface): DriftResult {
  const changes: DriftChange[] = [];

  // Check for canonicalization version mismatch
  // Old lockfiles (v1) won't have this field
  const baselineCanonicalVer = baseline.meta.canonicalVersion ?? 0;
  const currentCanonicalVer = current.meta.canonicalVersion ?? 0;

  if (baselineCanonicalVer !== currentCanonicalVer) {
    // This is not a real drift change, but a warning that the comparison
    // crosses a canonicalization change boundary
    console.warn(
      `Warning: Baseline was captured with canonicalization v${baselineCanonicalVer}, ` +
        `current uses v${currentCanonicalVer}. Some changes may be artifacts of the ` +
        `canonicalization change. Recommend re-running 'mcpward baseline' to update.`
    );
  }

  const baselineTools = new Set(Object.keys(baseline.tools));
  const currentTools = new Set(Object.keys(current.tools));

  // Check for removed tools (in baseline, not in current)
  for (const toolName of baselineTools) {
    if (!currentTools.has(toolName)) {
      const driftClass: DriftClass = 'tool_removed';
      changes.push({
        tool: toolName,
        class: driftClass,
        severity: getDefaultSeverity(driftClass),
        message: `Tool "${toolName}" was removed`,
        previous: baseline.tools[toolName],
        current: undefined,
      });
    }
  }

  // Check for added tools (in current, not in baseline)
  for (const toolName of currentTools) {
    if (!baselineTools.has(toolName)) {
      const driftClass: DriftClass = 'tool_added';
      changes.push({
        tool: toolName,
        class: driftClass,
        severity: getDefaultSeverity(driftClass),
        message: `Tool "${toolName}" was added`,
        previous: undefined,
        current: current.tools[toolName],
      });
    }
  }

  // Check for changes in existing tools
  for (const toolName of baselineTools) {
    if (currentTools.has(toolName)) {
      const baselineTool = baseline.tools[toolName];
      const currentTool = current.tools[toolName];
      if (baselineTool && currentTool) {
        changes.push(...diffTool(toolName, baselineTool, currentTool));
      }
    }
  }

  return {
    changes,
    unchanged: changes.length === 0,
  };
}

/**
 * Compares two tool surfaces and returns changes.
 */
function diffTool(toolName: string, baseline: ToolSurface, current: ToolSurface): DriftChange[] {
  const changes: DriftChange[] = [];

  // Check description hash (rug-pull detection)
  if (baseline.descriptionHash !== current.descriptionHash) {
    const driftClass: DriftClass = 'description_changed';

    // M2.4: Include full description text for rendering (if available)
    // If full_text was disabled or baseline is v1, fall back to hash
    const previous = baseline.description ?? baseline.descriptionHash;
    const current_value = current.description ?? current.descriptionHash;

    changes.push({
      tool: toolName,
      class: driftClass,
      severity: getDefaultSeverity(driftClass),
      message: `Tool "${toolName}" description changed (possible rug-pull)`,
      previous,
      current: current_value,
    });
  }

  // Check inputSchema changes
  const inputSchemaChanges = diffSchema(
    toolName,
    'inputSchema',
    baseline.inputSchema,
    current.inputSchema
  );
  changes.push(...inputSchemaChanges);

  // Check outputSchema changes
  const outputSchemaChanges = diffSchema(
    toolName,
    'outputSchema',
    baseline.outputSchema,
    current.outputSchema
  );
  changes.push(...outputSchemaChanges);

  // Check inferred output shape changes (M3) — only when both sides were sampled
  if (baseline.outputShape && current.outputShape) {
    changes.push(...diffOutputShapes(toolName, baseline.outputShape, current.outputShape));
  }

  // Check annotation changes
  const annotationChanges = diffAnnotations(toolName, baseline.annotations, current.annotations);
  changes.push(...annotationChanges);

  return changes;
}

/**
 * Compares two JSON schemas and classifies every change as breaking or non-breaking (M6.3).
 *
 * Walks the schema recursively — nested `properties`, array `items`, `additionalProperties` —
 * and reports paths like `filter.status` or `rows[].id`. Canonicalizes defensively first: a
 * lockfile written by an older mcpward may not be canonical.
 *
 * Classification per node (the drift truth table):
 * - breaking: property removed; required property added; optional → required; type narrowed or
 *   changed; enum value removed or enum added; min-bound raised/added; max-bound lowered/added;
 *   pattern/format/const/multipleOf added or changed; uniqueItems turned on;
 *   additionalProperties closed; items constraint added; schema removed
 * - non-breaking: optional property added (`input_property_added` in an inputSchema, medium,
 *   high if the field looks hostile); required → optional; type widened; enum value added
 *   or enum removed; bounds relaxed or removed; pattern/format/const/multipleOf removed;
 *   uniqueItems turned off; additionalProperties opened; items constraint removed; schema added
 * - a parameter's `description` changing is `description_changed` (the model reads it too)
 *
 * Where compatibility cannot be proven (a changed `pattern`, a changed anyOf/oneOf/allOf), the
 * change is classified as breaking and the message says so. No false precision.
 */
function diffSchema(
  toolName: string,
  schemaType: 'inputSchema' | 'outputSchema',
  baseline: JsonSchema | null,
  current: JsonSchema | null
): DriftChange[] {
  const changes: DriftChange[] = [];

  // Canonicalize defensively (old lockfiles may not be canonical)
  const baselineCanonical = canonicalizeSchema(baseline);
  const currentCanonical = canonicalizeSchema(current);

  const emit: Emit = (driftClass, message, previous, curr, severity) => {
    // A field the server adds to its OUTPUT is not something the model fills in: no
    // input_property_added, and no escalation, whatever class the change ended up in
    if (schemaType === 'outputSchema') {
      if (driftClass === 'input_property_added') driftClass = 'nonbreaking_schema_change';
      severity = undefined;
    }
    changes.push({
      tool: toolName,
      class: driftClass,
      severity: severity ?? getDefaultSeverity(driftClass),
      message: `Tool "${toolName}" ${schemaType} ${message}`,
      previous,
      current: curr,
    });
  };

  // Schema was added (null → something): non-breaking
  if (baselineCanonical === null && currentCanonical !== null) {
    emit('nonbreaking_schema_change', 'was added', null, currentCanonical);
    return changes;
  }

  // Schema was removed (something → null): breaking
  if (baselineCanonical !== null && currentCanonical === null) {
    emit('breaking_schema_change', 'was removed', baselineCanonical, null);
    return changes;
  }

  if (baselineCanonical === null || currentCanonical === null) {
    return changes;
  }

  diffSchemaNode(baselineCanonical, currentCanonical, '', 0, emit, currentCanonical);
  return changes;
}

/** `severity` overrides the class default (an escalated `input_property_added`). */
type Emit = (
  driftClass: DriftClass,
  message: string,
  previous: unknown,
  current: unknown,
  severity?: DriftSeverity
) => void;

/** Nesting limit for the recursive walk (canonicalizeSchema already bounds input depth). */
const MAX_DIFF_DEPTH = 64;

const MIN_BOUNDS = [
  'minimum',
  'exclusiveMinimum',
  'minLength',
  'minItems',
  'minProperties',
] as const;
const MAX_BOUNDS = [
  'maximum',
  'exclusiveMaximum',
  'maxLength',
  'maxItems',
  'maxProperties',
] as const;
/** Constraints where any addition or change narrows what is accepted, removal widens it. */
const OPAQUE_CONSTRAINTS = ['pattern', 'format', 'const', 'multipleOf'] as const;
const COMBINATORS = ['anyOf', 'oneOf', 'allOf'] as const;
/** Named subschemas, compared name by name (a `$ref` target changes there, not at the `$ref`). */
const DEFINITION_KEYWORDS = ['$defs', 'definitions'] as const;
/** Keywords diffSchemaNode compares itself; every other constraint goes to the catch-all. */
const MODELLED_KEYWORDS = new Set<string>([
  'type',
  'enum',
  ...MIN_BOUNDS,
  ...MAX_BOUNDS,
  ...OPAQUE_CONSTRAINTS,
  'uniqueItems',
  ...COMBINATORS,
  'additionalProperties',
  'properties',
  'required',
  'items',
  'additionalItems',
  ...DEFINITION_KEYWORDS,
]);

function asSchema(value: unknown): JsonSchema | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonSchema)
    : null;
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/**
 * Compares one schema node and recurses into its children. `path` is '' for the root,
 * `a.b` for nested properties, `a[]` for array items, `a{}` for additionalProperties.
 */
/**
 * `currRoot` is the schema resource `curr` belongs to — the whole current schema, or the nearest
 * enclosing subschema with its own `$id`: a new field's `$ref` is resolved against it.
 */
function diffSchemaNode(
  base: JsonSchema,
  curr: JsonSchema,
  path: string,
  depth: number,
  emit: Emit,
  currRoot: JsonSchema
): void {
  if (depth > MAX_DIFF_DEPTH) return;
  if (isSchemaResource(curr)) currRoot = curr;
  // Subject used in messages: root-level keywords read "inputSchema enum ...",
  // nested ones read `inputSchema property "a.b" ...` (matching the established wording).
  const subject = path === '' ? '' : `property "${path}" `;

  // --- description (parameter-level rug-pull vector) ---
  if (path !== '') {
    diffDescription(base.description, curr.description, subject, emit);
  }

  // --- type ---
  const baseType = base.type as string | string[] | undefined;
  const currType = curr.type as string | string[] | undefined;
  if (!same(baseType, currType)) {
    const kind = classifyTypeChange(baseType, currType);
    if (kind === 'widening') {
      emit(
        'nonbreaking_schema_change',
        `${subject}type widened from ${JSON.stringify(baseType)} to ${JSON.stringify(currType)}`,
        baseType,
        currType
      );
    } else {
      const verb = kind === 'narrowing' ? 'narrowed' : 'changed';
      emit(
        'breaking_schema_change',
        `${subject}type ${verb} from ${JSON.stringify(baseType)} to ${JSON.stringify(currType)}`,
        baseType,
        currType
      );
    }
  }

  // --- enum ---
  const baseEnum = Array.isArray(base.enum) ? (base.enum as unknown[]) : undefined;
  const currEnum = Array.isArray(curr.enum) ? (curr.enum as unknown[]) : undefined;
  if (baseEnum && currEnum) {
    const baseKeys = new Set(baseEnum.map((v) => canonicalJson(v)));
    const currKeys = new Set(currEnum.map((v) => canonicalJson(v)));
    const removed = baseEnum.filter((v) => !currKeys.has(canonicalJson(v)));
    const added = currEnum.filter((v) => !baseKeys.has(canonicalJson(v)));
    if (removed.length > 0) {
      emit(
        'breaking_schema_change',
        `${subject}enum tightened: removed ${JSON.stringify(removed)}`,
        baseEnum,
        currEnum
      );
    }
    if (added.length > 0) {
      emit(
        'nonbreaking_schema_change',
        `${subject}enum loosened: added ${JSON.stringify(added)}`,
        baseEnum,
        currEnum
      );
    }
  } else if (!baseEnum && currEnum) {
    emit(
      'breaking_schema_change',
      `${subject}enum constraint added ${JSON.stringify(currEnum)}`,
      undefined,
      currEnum
    );
  } else if (baseEnum && !currEnum) {
    emit('nonbreaking_schema_change', `${subject}enum constraint removed`, baseEnum, undefined);
  }

  // --- numeric bounds ---
  const diffBound = (key: string, tightenWhenHigher: boolean) => {
    const b = base[key];
    const c = curr[key];
    if (same(b, c)) return;
    if (b === undefined) {
      emit('breaking_schema_change', `${subject}${key} added (${JSON.stringify(c)})`, undefined, c);
    } else if (c === undefined) {
      emit(
        'nonbreaking_schema_change',
        `${subject}${key} removed (was ${JSON.stringify(b)})`,
        b,
        undefined
      );
    } else if (typeof b === 'number' && typeof c === 'number') {
      const tightened = tightenWhenHigher ? c > b : c < b;
      emit(
        tightened ? 'breaking_schema_change' : 'nonbreaking_schema_change',
        `${subject}${key} ${c > b ? 'raised' : 'lowered'} from ${b} to ${c}`,
        b,
        c
      );
    } else {
      emit(
        'breaking_schema_change',
        `${subject}${key} changed from ${JSON.stringify(b)} to ${JSON.stringify(c)} (compatibility cannot be determined)`,
        b,
        c
      );
    }
  };
  for (const key of MIN_BOUNDS) diffBound(key, true);
  for (const key of MAX_BOUNDS) diffBound(key, false);

  // --- pattern / format / const / multipleOf ---
  for (const key of OPAQUE_CONSTRAINTS) {
    const b = base[key];
    const c = curr[key];
    if (same(b, c)) continue;
    if (c === undefined) {
      emit(
        'nonbreaking_schema_change',
        `${subject}${key} removed (was ${JSON.stringify(b)})`,
        b,
        undefined
      );
    } else {
      emit(
        'breaking_schema_change',
        b === undefined
          ? `${subject}${key} added (${JSON.stringify(c)})`
          : `${subject}${key} changed from ${JSON.stringify(b)} to ${JSON.stringify(c)} (compatibility cannot be proven)`,
        b,
        c
      );
    }
  }

  // --- uniqueItems ---
  if (base.uniqueItems !== true && curr.uniqueItems === true) {
    emit('breaking_schema_change', `${subject}uniqueItems turned on`, base.uniqueItems, true);
  } else if (base.uniqueItems === true && curr.uniqueItems !== true) {
    emit('nonbreaking_schema_change', `${subject}uniqueItems turned off`, true, curr.uniqueItems);
  }

  // --- anyOf / oneOf / allOf: cannot classify structurally — conservative ---
  for (const key of COMBINATORS) {
    if (!same(base[key], curr[key])) {
      const reason = newHostility(key, base[key], curr[key], path, currRoot);
      emit(
        'breaking_schema_change',
        `${subject}${key} changed (compatibility cannot be determined; classified as breaking)${reason ? ` — ${reason}` : ''}`,
        base[key],
        curr[key],
        reason ? 'high' : undefined
      );
    }
  }

  // --- additionalProperties ---
  const openness = (v: unknown) => (v === false ? 'closed' : asSchema(v) ? 'schema' : 'open');
  const baseAdd = openness(base.additionalProperties);
  const currAdd = openness(curr.additionalProperties);
  if (baseAdd === 'schema' && currAdd === 'schema') {
    diffSchemaNode(
      asSchema(base.additionalProperties) as JsonSchema,
      asSchema(curr.additionalProperties) as JsonSchema,
      `${path}{}`,
      depth + 1,
      emit,
      currRoot
    );
  } else if (baseAdd !== currAdd) {
    // open ⊃ schema ⊃ closed
    const rank = { open: 2, schema: 1, closed: 0 } as const;
    emit(
      rank[currAdd] < rank[baseAdd] ? 'breaking_schema_change' : 'nonbreaking_schema_change',
      `${subject}additionalProperties ${baseAdd} → ${currAdd}`,
      base.additionalProperties,
      curr.additionalProperties
    );
  }

  // --- properties ---
  const baseProps = (asSchema(base.properties) ?? {}) as Record<string, unknown>;
  const currProps = (asSchema(curr.properties) ?? {}) as Record<string, unknown>;
  const baseRequired = new Set(Array.isArray(base.required) ? base.required : []);
  const currRequired = new Set(Array.isArray(curr.required) ? curr.required : []);
  const child = (name: string) => (path === '' ? name : `${path}.${name}`);

  // `required` may name properties that are not declared in `properties` — still a contract
  const names = new Set<string>([
    ...Object.keys(baseProps),
    ...Object.keys(currProps),
    ...baseRequired,
    ...currRequired,
  ]);
  for (const name of names) {
    const wasPresent = Object.hasOwn(baseProps, name);
    const isPresent = Object.hasOwn(currProps, name);
    const childPath = child(name);

    if (wasPresent && !isPresent) {
      emit(
        'breaking_schema_change',
        `property "${childPath}" was removed`,
        baseProps[name],
        undefined
      );
      continue;
    }
    if (!wasPresent && isPresent) {
      if (currRequired.has(name)) {
        emit(
          'breaking_schema_change',
          `added required property "${childPath}"`,
          undefined,
          currProps[name]
        );
      } else {
        emitInputPropertyAdded(name, childPath, currProps[name], emit, currRoot);
      }
      continue;
    }

    if (!baseRequired.has(name) && currRequired.has(name)) {
      emit(
        'breaking_schema_change',
        `property "${childPath}" became required`,
        { required: false },
        { required: true }
      );
    } else if (baseRequired.has(name) && !currRequired.has(name)) {
      emit(
        'nonbreaking_schema_change',
        `property "${childPath}" became optional`,
        { required: true },
        { required: false }
      );
    }

    if (wasPresent && isPresent) {
      diffSubschema(baseProps[name], currProps[name], childPath, depth, emit, currRoot);
    }
  }

  // --- $defs / definitions: compared by name, so a change in a `$ref` target is seen ---
  // A definition used under `not`/`if`/`oneOf`: accepting more there can reject more
  let negated: Set<string> | undefined;
  const defEmit = (def: string): Emit => {
    negated ??= new Set([...invertedDefinitions(base), ...invertedDefinitions(curr)]);
    if (!negated.has(def)) return emit;
    // An optional field added there can reject more too (`additionalProperties: false`)
    return (cls, message, previous, current, severity) =>
      cls === 'nonbreaking_schema_change' || cls === 'input_property_added'
        ? emit(
            'breaking_schema_change',
            `${message} (the definition is used under not/if/oneOf, where accepting more can reject more; classified as breaking)`,
            previous,
            current,
            severity // a hostile new field stays high
          )
        : emit(cls, message, previous, current, severity);
  };
  for (const key of DEFINITION_KEYWORDS) {
    const baseDefs = (asSchema(base[key]) ?? {}) as Record<string, unknown>;
    const currDefs = (asSchema(curr[key]) ?? {}) as Record<string, unknown>;
    for (const name of new Set([...Object.keys(baseDefs), ...Object.keys(currDefs)])) {
      const defPath = path === '' ? `${key}/${name}` : `${path}.${key}/${name}`;
      if (!Object.hasOwn(baseDefs, name)) {
        emit(
          'nonbreaking_schema_change',
          `definition "${defPath}" added`,
          undefined,
          currDefs[name]
        );
      } else if (!Object.hasOwn(currDefs, name)) {
        emit(
          'breaking_schema_change',
          `definition "${defPath}" was removed`,
          baseDefs[name],
          undefined
        );
      } else {
        diffSubschema(
          baseDefs[name],
          currDefs[name],
          defPath,
          depth,
          defEmit(`${key}/${name}`),
          currRoot
        );
      }
    }
  }

  // --- every other keyword (prefixItems, contains, not, if/then/else, dependentRequired,
  // $ref, $schema, …): not modelled, so a change cannot be classified. Like anyOf, it is
  // breaking — even a removal (dropping `prefixItems` next to `items: false` rejects more, and
  // a new `$schema` dialect can switch keywords on). ---
  for (const key of new Set([...Object.keys(base), ...Object.keys(curr)])) {
    if (
      MODELLED_KEYWORDS.has(key) ||
      ANNOTATION_KEYWORDS.has(key) ||
      key.startsWith('x-') // vendor extensions annotate, they do not constrain
    ) {
      continue;
    }
    const b = base[key];
    const c = curr[key];
    if (same(b, c)) continue;
    const verb = b === undefined ? 'added' : c === undefined ? 'removed' : 'changed';
    const reason = newHostility(key, b, c, path, currRoot);
    emit(
      'breaking_schema_change',
      `${subject}${key} ${verb} (compatibility cannot be determined; classified as breaking)${reason ? ` — ${reason}` : ''}`,
      b,
      c,
      reason ? 'high' : undefined
    );
  }

  // --- items ---
  const itemsPath = `${path}[]`;
  const baseItems = base.items;
  const currItems = curr.items;
  if (Array.isArray(baseItems) && Array.isArray(currItems)) {
    // Tuple form: compare position by position. A position beyond the tuple is governed by
    // `additionalItems` (absent = accept anything), so a dropped position is compared with the
    // NEW additionalItems and an added position with the OLD one — that covers false, true and
    // schema-valued additionalItems with the same subschema rules.
    const n = Math.max(baseItems.length, currItems.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      const before = i < baseItems.length ? baseItems[i] : (base.additionalItems ?? true);
      const after = i < currItems.length ? currItems[i] : (curr.additionalItems ?? true);
      diffSubschema(before, after, p, depth, emit, currRoot);
    }
    // Every position past both tuples is governed by additionalItems alone
    diffSubschema(
      base.additionalItems ?? true,
      curr.additionalItems ?? true,
      `${path}[${n}+]`,
      depth,
      emit,
      currRoot
    );
  } else if (
    baseItems !== undefined &&
    currItems !== undefined &&
    !Array.isArray(baseItems) &&
    !Array.isArray(currItems)
  ) {
    diffSubschema(baseItems, currItems, itemsPath, depth, emit, currRoot);
  } else if (baseItems === undefined && currItems !== undefined) {
    emit(
      'breaking_schema_change',
      `property "${itemsPath}" items constraint added`,
      undefined,
      currItems
    );
  } else if (baseItems !== undefined && currItems === undefined) {
    emit(
      'nonbreaking_schema_change',
      `property "${itemsPath}" items constraint removed`,
      baseItems,
      undefined
    );
  } else if (!same(baseItems, currItems)) {
    emit(
      'breaking_schema_change',
      `property "${itemsPath}" items changed between list and tuple form (compatibility cannot be determined)`,
      baseItems,
      currItems
    );
  }
}

/**
 * A new optional input field. Its description is quoted in the message because the model reads
 * it and nothing else diffs it: the field is new, so there is no previous description.
 */
function emitInputPropertyAdded(
  name: string,
  path: string,
  schema: unknown,
  emit: Emit,
  currRoot: JsonSchema
): void {
  // The model reads the description of a `$ref` target too: follow local references to it
  let s = asSchema(schema);
  let root: unknown = currRoot;
  const seen = new Set<unknown>();
  while (s && typeof s.description !== 'string' && typeof s.$ref === 'string' && !seen.has(s)) {
    seen.add(s);
    if (isSchemaResource(s)) root = s;
    // The next reference resolves in the resource the pointer led into
    const target = resolveLocalRefIn(root, s.$ref);
    s = asSchema(target?.node);
    root = target?.base;
  }
  const description = typeof s?.description === 'string' ? s.description : '';
  // Quoted whole and raw: report redaction matches registered secrets by their exact value, so a
  // truncated or rewritten description could leak one. Reporters mark hidden characters later.
  const quoted = description === '' ? 'no description' : `description "${description}"`;
  const reason = suspiciousNewInput(name, path, schema, currRoot);
  emit(
    'input_property_added',
    `added optional property "${path}" (${quoted})${reason ? ` — ${reason}` : ''}`,
    undefined,
    schema,
    reason ? 'high' : undefined
  );
}

/**
 * Why a new input field looks hostile, or undefined. Checks the field and everything nested in
 * it (a new `options` object can carry `options.api_key`) with the same heuristics as the
 * security checks: a secret-soliciting name, injection phrasing or hidden unicode in a description.
 */
function suspiciousNewInput(
  name: string,
  path: string,
  schema: unknown,
  currRoot: JsonSchema
): string | undefined {
  // Walk the field as the only property of a root, then re-anchor the paths at its real path.
  // `$ref`s inside it resolve against the real schema (`auth: { $ref: '#/$defs/Auth' }`).
  const root = { properties: { [name]: schema } };
  const at = (p: string) => path + p.slice(name.length);
  const params = walkParams(root, currRoot);
  const secret = params.find((p) => p.name !== undefined && isSecretField(p.name));
  if (secret) return `"${at(secret.path)}" solicits a secret`;
  for (const { path: p, description } of collectParamDescriptions(root, currRoot)) {
    if (findInjectionPatterns(description).length > 0) {
      return `"${at(p)}" description contains injection-like phrasing`;
    }
    if (findSuspiciousUnicode(description).length > 0) {
      return `"${at(p)}" description contains hidden unicode`;
    }
  }
  return undefined;
}

/** Every hostile-looking parameter reached through `{ [key]: value }`, as reasons. */
function hostileFindings(
  key: string,
  value: unknown,
  path: string,
  currRoot: JsonSchema
): Set<string> {
  const found = new Set<string>();
  if (value === undefined) return found;
  // Below the root, walk the keyword as part of the field it belongs to, so an in-place branch
  // (`allOf: [{description}]`) is read as that field. A placeholder name keeps paths re-anchorable.
  const FIELD = '\u0000';
  const root = path === '' ? { [key]: value } : { properties: { [FIELD]: { [key]: value } } };
  const at = (p: string) => (path === '' ? p : path + p.slice(FIELD.length));
  for (const p of walkParams(root, currRoot)) {
    if (p.name !== undefined && p.name !== FIELD && isSecretField(p.name)) {
      found.add(`"${at(p.path)}" solicits a secret`);
    }
  }
  for (const { path: p, description } of collectParamDescriptions(root, currRoot)) {
    if (findInjectionPatterns(description).length > 0) {
      found.add(`"${at(p)}" description contains injection-like phrasing`);
    }
    if (findSuspiciousUnicode(description).length > 0) {
      found.add(`"${at(p)}" description contains hidden unicode`);
    }
  }
  return found;
}

/**
 * Why a changed keyword the walk cannot classify (`allOf`, `if`, `$ref`, …) brings in a
 * hostile-looking input — a secret-soliciting name or a poisoned description that was not there
 * before — or undefined. Such a change is escalated to high like a hostile new field.
 */
function newHostility(
  key: string,
  before: unknown,
  after: unknown,
  path: string,
  currRoot: JsonSchema
): string | undefined {
  const old = hostileFindings(key, before, path, currRoot);
  for (const reason of hostileFindings(key, after, path, currRoot)) {
    if (!old.has(reason)) return reason;
  }
  return undefined;
}

/**
 * Compares two subschemas, which may be objects OR the boolean schemas `true` (accept
 * anything) and `false` (reject everything). Objects recurse; otherwise acceptance is ranked
 * true > object > false, and moving down that order is breaking.
 */
function diffSubschema(
  base: unknown,
  curr: unknown,
  path: string,
  depth: number,
  emit: Emit,
  currRoot: JsonSchema
): void {
  const b = asSchema(base);
  const c = asSchema(curr);
  if (b && c) {
    diffSchemaNode(b, c, path, depth + 1, emit, currRoot);
    return;
  }
  if (same(base, curr)) return;

  // A description can arrive with the switch from `true` to an object schema — it is read by
  // the model all the same, so it must not hide behind a schema-change finding.
  diffDescription(b?.description, c?.description, `property "${path}" `, emit);

  const rank = (v: unknown) => (v === false ? 0 : acceptsAnything(v) ? 2 : 1);
  if (rank(base) === rank(curr)) return; // e.g. `true` ↔ `{}`: same accepted values
  const label = (v: unknown) =>
    v === false
      ? 'false (rejects everything)'
      : acceptsAnything(v)
        ? 'accept-anything'
        : 'a schema';
  // `auth: true` → `auth: {properties: {password}}` brings in new fields: same hostility test
  // (an in-place `allOf` of one schema is that schema)
  const reason = newHostility('allOf', [base], [curr], path, currRoot);
  emit(
    rank(curr) < rank(base) ? 'breaking_schema_change' : 'nonbreaking_schema_change',
    `property "${path}" changed from ${label(base)} to ${label(curr)}${reason ? ` — ${reason}` : ''}`,
    base,
    curr,
    reason ? 'high' : undefined
  );
}

/**
 * `$defs/Name` or `definitions/Name` for a same-document reference into a definition of
 * `schema` — `#/$defs/A`, a pointer inside it such as `#/$defs/A/properties/x`, or a plain-name
 * anchor (`#blocked`, `$anchor` or draft-07 `$id: "#blocked"`) declared on or inside it.
 */
function definitionOf(ref: unknown, schema: JsonSchema): string | undefined {
  if (typeof ref !== 'string') return undefined;
  const m = /^#\/(\$defs|definitions)\/([^/]+)(?:\/.*)?$/s.exec(ref);
  if (m) {
    try {
      return `${m[1]}/${decodeURIComponent(m[2] ?? '')
        .replace(/~1/g, '/')
        .replace(/~0/g, '~')}`;
    } catch {
      return undefined;
    }
  }
  if (!ref.startsWith('#') || ref.startsWith('#/')) return undefined;
  const target = resolveLocalRefIn(schema, ref)?.node;
  if (target === null || typeof target !== 'object') return undefined;
  for (const key of DEFINITION_KEYWORDS) {
    const defs = asSchema(schema[key]);
    if (!defs) continue;
    for (const [name, def] of Object.entries(defs)) {
      if (contains(def, target)) return `${key}/${name}`;
    }
  }
  return undefined;
}

/** True when `target` is `node` or an object somewhere inside it. */
function contains(node: unknown, target: object): boolean {
  const seen = new WeakSet<object>();
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === target) return true;
    if (n === null || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    // One push per value: spreading a huge `enum` into push() overflows the call stack
    for (const child of Object.values(n)) stack.push(child);
  }
  return false;
}

/** Keywords whose value maps names to subschemas. */
const SCHEMA_MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
  '$defs',
  'definitions',
] as const;
/** Keywords whose value is a subschema or a list of subschemas, applied with the same polarity. */
const SAME_POLARITY_KEYWORDS = [
  'items',
  'prefixItems',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'propertyNames',
  'then',
  'else',
  'allOf',
  'anyOf',
] as const;
/**
 * Keywords where accepting more can reject more: `not` inverts, `if` selects a branch, and
 * `oneOf` fails when a widened branch starts to overlap another. `contains` joins them next to
 * `maxContains`: more items match, and the count can exceed the maximum.
 */
const INVERTING_KEYWORDS = ['not', 'if', 'oneOf'] as const;

/** A pending step of {@link invertedDefinitions}; `nested`: inside a nested schema resource. */
interface PolarityVisit {
  node: unknown;
  inverting: boolean;
  nested: boolean;
}

/**
 * Definitions of `schema` used, directly or through other definitions, under `not`, `if`,
 * `oneOf` or a `contains` limited by `maxContains`. A "widening" inside such a definition cannot
 * be trusted. The walk follows schema keywords only, so a parameter NAMED `not` is not mistaken
 * for the keyword. Inside a nested schema resource (its own `$id`), `#…` references name that
 * resource, not `schema`: they are left to the comparison of the resource's own definitions.
 */
function invertedDefinitions(schema: JsonSchema): Set<string> {
  const inverted = new Set<string>();
  const stack: PolarityVisit[] = [{ node: schema, inverting: false, nested: false }];
  let nested = false;
  const push = (value: unknown, inverting: boolean) => {
    for (const node of Array.isArray(value) ? value : [value]) {
      stack.push({ node, inverting, nested });
    }
  };
  while (stack.length > 0) {
    const visit = stack.pop() as PolarityVisit;
    const s = asSchema(visit.node);
    if (!s) continue;
    const { inverting } = visit;
    nested = visit.nested || (s !== schema && isSchemaResource(s));
    if (inverting && !nested) {
      const def = definitionOf(s.$ref, schema);
      if (def !== undefined && !inverted.has(def)) {
        inverted.add(def);
        // Everything the definition uses is inverted too
        const [key, name] = def.split(/\/(.*)/s) as [string, string];
        const defs = asSchema(schema[key]);
        if (defs && Object.hasOwn(defs, name)) push(defs[name], true);
      }
    }
    for (const key of SCHEMA_MAP_KEYWORDS) {
      // Definitions are walked where declared too: one may use another under `not`
      const map = asSchema(s[key]);
      if (map) for (const child of Object.values(map)) push(child, inverting);
    }
    for (const key of SAME_POLARITY_KEYWORDS) push(s[key], inverting);
    push(s.contains, inverting || s.maxContains !== undefined);
    for (const key of INVERTING_KEYWORDS) push(s[key], true);
  }
  return inverted;
}

/** Keywords that annotate a schema without constraining which values it accepts. */
const ANNOTATION_KEYWORDS = new Set([
  'title',
  'description',
  'default',
  'examples',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

/** `true`, an absent schema, and `{}` (or annotations only) all accept every value. */
function acceptsAnything(v: unknown): boolean {
  if (v === true || v === undefined) return true;
  const s = asSchema(v);
  return s !== null && Object.keys(s).every((k) => ANNOTATION_KEYWORDS.has(k));
}

/**
 * Parameter descriptions are a rug-pull vector like tool descriptions. Absent counts as empty —
 * ADDING a description to a parameter that had none is the easiest rug-pull of all. Compared
 * canonically, so formatting-only edits are not drift; invisible characters still are.
 */
function diffDescription(before: unknown, after: unknown, subject: string, emit: Emit): void {
  const b = typeof before === 'string' ? before : '';
  const a = typeof after === 'string' ? after : '';
  if (canonicalizeDescription(b) === canonicalizeDescription(a)) return;
  const what =
    b === '' ? 'description added' : a === '' ? 'description removed' : 'description changed';
  emit('description_changed', `${subject}${what} (possible rug-pull)`, before, after);
}

type HintName = 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint';

/**
 * The four MCP tool hints: the value the MCP spec assumes when a hint is absent, the value that
 * claims the riskier tool, and what each direction means. destructiveHint and idempotentHint
 * only mean something when the tool is not read-only.
 */
const HINTS: readonly {
  name: HintName;
  absent: boolean;
  riskier: boolean;
  riskierMeaning: string;
  saferMeaning: string;
}[] = [
  {
    name: 'readOnlyHint',
    absent: false,
    riskier: false,
    riskierMeaning: 'tool may now mutate state',
    saferMeaning: 'tool now claims to be read-only',
  },
  {
    name: 'destructiveHint',
    absent: true,
    riskier: true,
    riskierMeaning: 'tool may now destroy data',
    saferMeaning: 'tool now claims to be non-destructive',
  },
  {
    name: 'idempotentHint',
    absent: false,
    riskier: false,
    riskierMeaning: 'repeated calls may now have additional effects',
    saferMeaning: 'tool now claims repeated calls are harmless',
  },
  {
    name: 'openWorldHint',
    absent: true,
    riskier: true,
    riskierMeaning: 'tool may now reach external entities',
    saferMeaning: 'tool now claims to stay within its own domain',
  },
];

function showHint(value: boolean | undefined, absent: boolean): string {
  return value === undefined ? `absent (means ${absent})` : String(value);
}

/**
 * Compares tool annotations in both directions, on effective values: an absent hint counts as
 * the value the MCP spec assumes for it, so a hint that appears or disappears is classified too.
 *
 * - readOnlyHint, destructiveHint, openWorldHint now claim a riskier tool → annotation_changed
 *   (high); a safer tool → annotation_relaxed (medium): the path to auto-approval.
 * - idempotentHint changed, either direction → idempotency_changed (medium): a retry risk,
 *   not a data risk.
 *
 * destructiveHint and idempotentHint only apply to a tool that is not read-only, so they are
 * compared only when it is not read-only on either side: a tool that becomes read-only and drops
 * its destructiveHint is a safer claim, reported once as the readOnlyHint change.
 */
function diffAnnotations(
  toolName: string,
  baseline: ToolSurface['annotations'],
  current: ToolSurface['annotations']
): DriftChange[] {
  const changes: DriftChange[] = [];
  const readOnlyEither = (baseline?.readOnlyHint ?? false) || (current?.readOnlyHint ?? false);

  for (const hint of HINTS) {
    if (readOnlyEither && (hint.name === 'destructiveHint' || hint.name === 'idempotentHint')) {
      continue;
    }
    const before = baseline?.[hint.name];
    const after = current?.[hint.name];
    if ((before ?? hint.absent) === (after ?? hint.absent)) continue;

    const riskier = (after ?? hint.absent) === hint.riskier;
    const driftClass: DriftClass =
      hint.name === 'idempotentHint'
        ? 'idempotency_changed'
        : riskier
          ? 'annotation_changed'
          : 'annotation_relaxed';
    const meaning = riskier ? hint.riskierMeaning : hint.saferMeaning;
    changes.push({
      tool: toolName,
      class: driftClass,
      severity: getDefaultSeverity(driftClass),
      message: `Tool "${toolName}" ${hint.name} changed from ${showHint(before, hint.absent)} to ${showHint(after, hint.absent)} (${meaning})`,
      previous: { [hint.name]: before ?? null },
      current: { [hint.name]: after ?? null },
    });
  }

  return changes;
}

/**
 * Classes that took over part of an older class's meaning. Config written before the split
 * that names the older class keeps covering the same changes: added optional input fields were
 * `nonbreaking_schema_change` until 1.2.0.
 */
const LEGACY_PARENT: Partial<Record<DriftClass, DriftClass>> = {
  input_property_added: 'nonbreaking_schema_change',
};

/**
 * Applies user per-class severity overrides (`checks.drift.severity`) to changes.
 * An override for a class's legacy parent applies too; the class's own override wins.
 * Runs after the classifier, so an override also beats a default escalation.
 * Pure: returns new change objects, never mutates the input.
 */
export function applySeverityOverrides(
  changes: DriftChange[],
  overrides: Partial<Record<DriftClass, DriftSeverity>> | undefined
): DriftChange[] {
  if (!overrides || Object.keys(overrides).length === 0) return changes;
  return changes.map((change) => {
    const parent = LEGACY_PARENT[change.class];
    const override = overrides[change.class] ?? (parent ? overrides[parent] : undefined);
    return override ? { ...change, severity: override } : change;
  });
}

/**
 * Filters changes to only those that should cause a failure
 * based on the fail_on configuration (M2).
 *
 * fail_on can be either:
 * 1. Array of drift classes (legacy): ['tool_removed', 'description_changed', ...]
 *    A class whose legacy parent is listed fails too (see LEGACY_PARENT).
 * 2. Severity threshold (M2): 'high' | 'medium' | 'low'
 *
 * Severity threshold semantics:
 * - 'high': fail only on high severity changes
 * - 'medium': fail on high AND medium severity changes
 * - 'low': fail on everything (high, medium, low)
 */
export function filterFailingChanges(
  changes: DriftChange[],
  failOn: string[] | 'high' | 'medium' | 'low'
): DriftChange[] {
  // Legacy mode: array of drift classes
  if (Array.isArray(failOn)) {
    const failOnSet = new Set(failOn);
    return changes.filter((change) => {
      const parent = LEGACY_PARENT[change.class];
      return failOnSet.has(change.class) || (parent !== undefined && failOnSet.has(parent));
    });
  }

  // M2 mode: severity threshold
  const threshold = failOn;
  const severityRank = { high: 3, medium: 2, low: 1 };
  const thresholdRank = severityRank[threshold];

  return changes.filter((change) => {
    const changeRank = severityRank[change.severity];
    return changeRank >= thresholdRank;
  });
}
