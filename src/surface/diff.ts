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
import { canonicalizeSchema } from './canonical.js';

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
 * Compares two JSON schemas and classifies the change as breaking or non-breaking.
 *
 * Canonicalizes defensively before comparison - a lockfile written by an older
 * mcpward version may not be in canonical form.
 *
 * Breaking changes:
 * - Added required field (clients won't provide it)
 * - Removed field (clients may rely on it)
 * - Narrowed type (e.g., string → enum subset)
 * - Tightened constraints
 * - Schema removed entirely
 *
 * Non-breaking changes:
 * - Added optional field
 * - Widened type
 * - Loosened constraints
 * - Schema added (was null)
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

  // Schema was added (null → something): non-breaking
  if (baselineCanonical === null && currentCanonical !== null) {
    const driftClass: DriftClass = 'nonbreaking_schema_change';
    changes.push({
      tool: toolName,
      class: driftClass,
      severity: getDefaultSeverity(driftClass),
      message: `Tool "${toolName}" ${schemaType} was added`,
      previous: null,
      current: currentCanonical,
    });
    return changes;
  }

  // Schema was removed (something → null): breaking
  if (baselineCanonical !== null && currentCanonical === null) {
    const driftClass: DriftClass = 'breaking_schema_change';
    changes.push({
      tool: toolName,
      class: driftClass,
      severity: getDefaultSeverity(driftClass),
      message: `Tool "${toolName}" ${schemaType} was removed`,
      previous: baselineCanonical,
      current: null,
    });
    return changes;
  }

  // Both null: no change
  if (baselineCanonical === null && currentCanonical === null) {
    return changes;
  }

  // At this point both baseline and current are non-null
  const baselineSchema = baselineCanonical as JsonSchema;
  const currentSchema = currentCanonical as JsonSchema;

  // Both present: compare properties
  const baselineProps = baselineSchema.properties ?? {};
  const currentProps = currentSchema.properties ?? {};
  const baselineRequired = new Set(baselineSchema.required ?? []);
  const currentRequired = new Set(currentSchema.required ?? []);

  const allProps = new Set([
    ...Object.keys(baselineProps),
    ...Object.keys(currentProps),
  ]);

  for (const propName of allProps) {
    const wasPresent = propName in baselineProps;
    const isPresent = propName in currentProps;
    const wasRequired = baselineRequired.has(propName);
    const isRequired = currentRequired.has(propName);

    // Property removed: breaking
    if (wasPresent && !isPresent) {
      const driftClass: DriftClass = 'breaking_schema_change';
      changes.push({
        tool: toolName,
        class: driftClass,
        severity: getDefaultSeverity(driftClass),
        message: `Tool "${toolName}" ${schemaType} property "${propName}" was removed`,
        previous: baselineProps[propName],
        current: undefined,
      });
      continue;
    }

    // Property added
    if (!wasPresent && isPresent) {
      if (isRequired) {
        // New required field: breaking (clients won't provide it)
        const driftClass: DriftClass = 'breaking_schema_change';
        changes.push({
          tool: toolName,
          class: driftClass,
          severity: getDefaultSeverity(driftClass),
          message: `Tool "${toolName}" ${schemaType} added required property "${propName}"`,
          previous: undefined,
          current: currentProps[propName],
        });
      } else {
        // New optional field: non-breaking
        const driftClass: DriftClass = 'nonbreaking_schema_change';
        changes.push({
          tool: toolName,
          class: driftClass,
          severity: getDefaultSeverity(driftClass),
          message: `Tool "${toolName}" ${schemaType} added optional property "${propName}"`,
          previous: undefined,
          current: currentProps[propName],
        });
      }
      continue;
    }

    // Property exists in both: check required status change
    if (wasPresent && isPresent) {
      if (!wasRequired && isRequired) {
        // Optional → required: breaking
        const driftClass: DriftClass = 'breaking_schema_change';
        changes.push({
          tool: toolName,
          class: driftClass,
          severity: getDefaultSeverity(driftClass),
          message: `Tool "${toolName}" ${schemaType} property "${propName}" became required`,
          previous: { required: false },
          current: { required: true },
        });
      } else if (wasRequired && !isRequired) {
        // Required → optional: non-breaking
        const driftClass: DriftClass = 'nonbreaking_schema_change';
        changes.push({
          tool: toolName,
          class: driftClass,
          severity: getDefaultSeverity(driftClass),
          message: `Tool "${toolName}" ${schemaType} property "${propName}" became optional`,
          previous: { required: true },
          current: { required: false },
        });
      }

      // Check type changes (M2.2 - distinguish widening/narrowing/unrelated)
      const baselineProp = baselineProps[propName] as { type?: string | string[] };
      const currentProp = currentProps[propName] as { type?: string | string[] };
      const baselineType = baselineProp?.type;
      const currentType = currentProp?.type;

      if (JSON.stringify(baselineType) !== JSON.stringify(currentType)) {
        const changeKind = classifyTypeChange(baselineType, currentType);

        if (changeKind === 'widening') {
          // Type became more permissive (string → string|number): non-breaking, low
          const driftClass: DriftClass = 'nonbreaking_schema_change';
          changes.push({
            tool: toolName,
            class: driftClass,
            severity: getDefaultSeverity(driftClass),
            message: `Tool "${toolName}" ${schemaType} property "${propName}" type widened from ${JSON.stringify(baselineType)} to ${JSON.stringify(currentType)}`,
            previous: baselineType,
            current: currentType,
          });
        } else {
          // Narrowing or unrelated: breaking, medium
          const driftClass: DriftClass = 'breaking_schema_change';
          const verb = changeKind === 'narrowing' ? 'narrowed' : 'changed';
          changes.push({
            tool: toolName,
            class: driftClass,
            severity: getDefaultSeverity(driftClass),
            message: `Tool "${toolName}" ${schemaType} property "${propName}" type ${verb} from ${JSON.stringify(baselineType)} to ${JSON.stringify(currentType)}`,
            previous: baselineType,
            current: currentType,
          });
        }
      }
    }
  }

  return changes;
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
