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
 * | Added optional field / widened type | nonbreaking_schema_change | no |
 * | readOnlyHint true→false or destructiveHint false→true | annotation_changed | yes |
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
import { canonicalizeSchema, canonicalJson } from './canonical.js';
import { diffOutputShapes } from './output-shape.js';

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
 * - medium: Changes breaking loudly at the call site (schema breaks)
 * - low: Visible, expected changes (tool add/remove, optional params)
 */
function getDefaultSeverity(driftClass: DriftClass): DriftSeverity {
  switch (driftClass) {
    case 'description_changed':
      // Rug-pull vector - the model reads this and makes decisions
      return 'high';

    case 'annotation_changed':
      // readOnlyHint true→false or destructiveHint false→true
      // Changes what a client auto-approves - silent authority increase
      return 'high';

    case 'breaking_schema_change':
      // New required field, removed field, narrowed type
      // Breaks loudly at the call site, but doesn't affect security
      return 'medium';

    case 'nonbreaking_schema_change':
      // Added optional field, widened type, loosened constraint
      return 'low';

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
  const baseTypes = Array.isArray(baselineType)
    ? baselineType
    : baselineType
      ? [baselineType]
      : [];
  const currTypes = Array.isArray(currentType)
    ? currentType
    : currentType
      ? [currentType]
      : [];

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
export function diffSurfaces(
  baseline: ServerSurface,
  current: ServerSurface
): DriftResult {
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
function diffTool(
  toolName: string,
  baseline: ToolSurface,
  current: ToolSurface
): DriftChange[] {
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
  const annotationChanges = diffAnnotations(
    toolName,
    baseline.annotations,
    current.annotations
  );
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
 * - non-breaking: optional property added; required → optional; type widened; enum value added
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

  const emit = (driftClass: DriftClass, message: string, previous: unknown, curr: unknown) => {
    changes.push({
      tool: toolName,
      class: driftClass,
      severity: getDefaultSeverity(driftClass),
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

  diffSchemaNode(baselineCanonical, currentCanonical, '', 0, emit);
  return changes;
}

type Emit = (driftClass: DriftClass, message: string, previous: unknown, current: unknown) => void;

/** Nesting limit for the recursive walk (canonicalizeSchema already bounds input depth). */
const MAX_DIFF_DEPTH = 64;

const MIN_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'] as const;
const MAX_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'] as const;
/** Constraints where any addition or change narrows what is accepted, removal widens it. */
const OPAQUE_CONSTRAINTS = ['pattern', 'format', 'const', 'multipleOf'] as const;
const COMBINATORS = ['anyOf', 'oneOf', 'allOf'] as const;

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
function diffSchemaNode(
  base: JsonSchema,
  curr: JsonSchema,
  path: string,
  depth: number,
  emit: Emit
): void {
  if (depth > MAX_DIFF_DEPTH) return;
  // Subject used in messages: root-level keywords read "inputSchema enum ...",
  // nested ones read `inputSchema property "a.b" ...` (matching the established wording).
  const subject = path === '' ? '' : `property "${path}" `;

  // --- description (parameter-level rug-pull vector) ---
  if (path !== '' && typeof base.description === 'string' && typeof curr.description === 'string') {
    if (base.description !== curr.description) {
      emit(
        'description_changed',
        `${subject}description changed (possible rug-pull)`,
        base.description,
        curr.description
      );
    }
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
      emit('breaking_schema_change', `${subject}enum tightened: removed ${JSON.stringify(removed)}`, baseEnum, currEnum);
    }
    if (added.length > 0) {
      emit('nonbreaking_schema_change', `${subject}enum loosened: added ${JSON.stringify(added)}`, baseEnum, currEnum);
    }
  } else if (!baseEnum && currEnum) {
    emit('breaking_schema_change', `${subject}enum constraint added ${JSON.stringify(currEnum)}`, undefined, currEnum);
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
      emit('nonbreaking_schema_change', `${subject}${key} removed (was ${JSON.stringify(b)})`, b, undefined);
    } else if (typeof b === 'number' && typeof c === 'number') {
      const tightened = tightenWhenHigher ? c > b : c < b;
      emit(
        tightened ? 'breaking_schema_change' : 'nonbreaking_schema_change',
        `${subject}${key} ${c > b ? 'raised' : 'lowered'} from ${b} to ${c}`,
        b,
        c
      );
    } else {
      emit('breaking_schema_change', `${subject}${key} changed from ${JSON.stringify(b)} to ${JSON.stringify(c)} (compatibility cannot be determined)`, b, c);
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
      emit('nonbreaking_schema_change', `${subject}${key} removed (was ${JSON.stringify(b)})`, b, undefined);
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
      emit(
        'breaking_schema_change',
        `${subject}${key} changed (compatibility cannot be determined; classified as breaking)`,
        base[key],
        curr[key]
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
      emit
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

  for (const name of new Set([...Object.keys(baseProps), ...Object.keys(currProps)])) {
    const wasPresent = Object.hasOwn(baseProps, name);
    const isPresent = Object.hasOwn(currProps, name);
    const childPath = child(name);

    if (wasPresent && !isPresent) {
      emit('breaking_schema_change', `property "${childPath}" was removed`, baseProps[name], undefined);
      continue;
    }
    if (!wasPresent && isPresent) {
      if (currRequired.has(name)) {
        emit('breaking_schema_change', `added required property "${childPath}"`, undefined, currProps[name]);
      } else {
        emit('nonbreaking_schema_change', `added optional property "${childPath}"`, undefined, currProps[name]);
      }
      continue;
    }

    if (!baseRequired.has(name) && currRequired.has(name)) {
      emit('breaking_schema_change', `property "${childPath}" became required`, { required: false }, { required: true });
    } else if (baseRequired.has(name) && !currRequired.has(name)) {
      emit('nonbreaking_schema_change', `property "${childPath}" became optional`, { required: true }, { required: false });
    }

    const baseChild = asSchema(baseProps[name]);
    const currChild = asSchema(currProps[name]);
    if (baseChild && currChild) {
      diffSchemaNode(baseChild, currChild, childPath, depth + 1, emit);
    }
  }

  // --- items ---
  const itemsPath = `${path}[]`;
  const baseItems = base.items;
  const currItems = curr.items;
  if (asSchema(baseItems) && asSchema(currItems)) {
    diffSchemaNode(baseItems as JsonSchema, currItems as JsonSchema, itemsPath, depth + 1, emit);
  } else if (Array.isArray(baseItems) && Array.isArray(currItems)) {
    // Tuple form: compare position by position
    const n = Math.max(baseItems.length, currItems.length);
    for (let i = 0; i < n; i++) {
      const b = asSchema(baseItems[i]);
      const c = asSchema(currItems[i]);
      if (b && c) diffSchemaNode(b, c, `${path}[${i}]`, depth + 1, emit);
      else if (!same(b, c)) {
        emit('breaking_schema_change', `property "${path}[${i}]" changed (tuple position ${c ? 'added' : 'removed'})`, b, c);
      }
    }
  } else if (baseItems === undefined && currItems !== undefined) {
    emit('breaking_schema_change', `property "${itemsPath}" items constraint added`, undefined, currItems);
  } else if (baseItems !== undefined && currItems === undefined) {
    emit('nonbreaking_schema_change', `property "${itemsPath}" items constraint removed`, baseItems, undefined);
  } else if (!same(baseItems, currItems)) {
    emit('breaking_schema_change', `property "${itemsPath}" items changed (compatibility cannot be determined)`, baseItems, currItems);
  }
}

/**
 * Compares tool annotations for security-relevant changes.
 *
 * Breaking annotation changes:
 * - readOnlyHint: true → false (tool became destructive)
 * - destructiveHint: false → true (tool became destructive)
 */
function diffAnnotations(
  toolName: string,
  baseline: ToolSurface['annotations'],
  current: ToolSurface['annotations']
): DriftChange[] {
  const changes: DriftChange[] = [];

  const baselineReadOnly = baseline?.readOnlyHint;
  const currentReadOnly = current?.readOnlyHint;
  const baselineDestructive = baseline?.destructiveHint;
  const currentDestructive = current?.destructiveHint;

  // readOnlyHint: true → false is concerning (tool became potentially mutating)
  if (baselineReadOnly === true && currentReadOnly === false) {
    const driftClass: DriftClass = 'annotation_changed';
    changes.push({
      tool: toolName,
      class: driftClass,
      severity: getDefaultSeverity(driftClass),
      message: `Tool "${toolName}" readOnlyHint changed from true to false (tool may now mutate state)`,
      previous: { readOnlyHint: true },
      current: { readOnlyHint: false },
    });
  }

  // destructiveHint: false → true is concerning (tool became destructive)
  if (baselineDestructive === false && currentDestructive === true) {
    const driftClass: DriftClass = 'annotation_changed';
    changes.push({
      tool: toolName,
      class: driftClass,
      severity: getDefaultSeverity(driftClass),
      message: `Tool "${toolName}" destructiveHint changed from false to true (tool became destructive)`,
      previous: { destructiveHint: false },
      current: { destructiveHint: true },
    });
  }

  return changes;
}

/**
 * Applies user per-class severity overrides (`checks.drift.severity`) to changes.
 * Pure: returns new change objects, never mutates the input.
 */
export function applySeverityOverrides(
  changes: DriftChange[],
  overrides: Partial<Record<DriftClass, DriftSeverity>> | undefined
): DriftChange[] {
  if (!overrides || Object.keys(overrides).length === 0) return changes;
  return changes.map((change) => {
    const override = overrides[change.class];
    return override ? { ...change, severity: override } : change;
  });
}

/**
 * Filters changes to only those that should cause a failure
 * based on the fail_on configuration (M2).
 *
 * fail_on can be either:
 * 1. Array of drift classes (legacy): ['tool_removed', 'description_changed', ...]
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
    return changes.filter((change) => failOnSet.has(change.class));
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
