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
  JsonSchema,
} from './types.js';

/**
 * Compares baseline and current surfaces, returning classified changes.
 * This is a pure function for easy testing.
 */
export function diffSurfaces(
  baseline: ServerSurface,
  current: ServerSurface
): DriftResult {
  const changes: DriftChange[] = [];

  const baselineTools = new Set(Object.keys(baseline.tools));
  const currentTools = new Set(Object.keys(current.tools));

  // Check for removed tools (in baseline, not in current)
  for (const toolName of baselineTools) {
    if (!currentTools.has(toolName)) {
      changes.push({
        tool: toolName,
        class: 'tool_removed',
        message: `Tool "${toolName}" was removed`,
        previous: baseline.tools[toolName],
        current: undefined,
      });
    }
  }

  // Check for added tools (in current, not in baseline)
  for (const toolName of currentTools) {
    if (!baselineTools.has(toolName)) {
      changes.push({
        tool: toolName,
        class: 'tool_added',
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
    changes.push({
      tool: toolName,
      class: 'description_changed',
      message: `Tool "${toolName}" description changed (possible rug-pull)`,
      previous: baseline.descriptionHash,
      current: current.descriptionHash,
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

  // Schema was added (null → something): non-breaking
  if (baseline === null && current !== null) {
    changes.push({
      tool: toolName,
      class: 'nonbreaking_schema_change',
      message: `Tool "${toolName}" ${schemaType} was added`,
      previous: null,
      current: current,
    });
    return changes;
  }

  // Schema was removed (something → null): breaking
  if (baseline !== null && current === null) {
    changes.push({
      tool: toolName,
      class: 'breaking_schema_change',
      message: `Tool "${toolName}" ${schemaType} was removed`,
      previous: baseline,
      current: null,
    });
    return changes;
  }

  // Both null: no change
  if (baseline === null && current === null) {
    return changes;
  }

  // At this point both baseline and current are non-null
  const baselineSchema = baseline as JsonSchema;
  const currentSchema = current as JsonSchema;

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
      changes.push({
        tool: toolName,
        class: 'breaking_schema_change',
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
        changes.push({
          tool: toolName,
          class: 'breaking_schema_change',
          message: `Tool "${toolName}" ${schemaType} added required property "${propName}"`,
          previous: undefined,
          current: currentProps[propName],
        });
      } else {
        // New optional field: non-breaking
        changes.push({
          tool: toolName,
          class: 'nonbreaking_schema_change',
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
        changes.push({
          tool: toolName,
          class: 'breaking_schema_change',
          message: `Tool "${toolName}" ${schemaType} property "${propName}" became required`,
          previous: { required: false },
          current: { required: true },
        });
      } else if (wasRequired && !isRequired) {
        // Required → optional: non-breaking
        changes.push({
          tool: toolName,
          class: 'nonbreaking_schema_change',
          message: `Tool "${toolName}" ${schemaType} property "${propName}" became optional`,
          previous: { required: true },
          current: { required: false },
        });
      }

      // Check type changes
      const baselineType = (baselineProps[propName] as { type?: string })?.type;
      const currentType = (currentProps[propName] as { type?: string })?.type;

      if (baselineType !== currentType) {
        // Type change: conservative - treat as breaking
        // A proper implementation would check if it's widening or narrowing
        changes.push({
          tool: toolName,
          class: 'breaking_schema_change',
          message: `Tool "${toolName}" ${schemaType} property "${propName}" type changed from "${baselineType}" to "${currentType}"`,
          previous: baselineType,
          current: currentType,
        });
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
    changes.push({
      tool: toolName,
      class: 'annotation_changed',
      message: `Tool "${toolName}" readOnlyHint changed from true to false (tool may now mutate state)`,
      previous: { readOnlyHint: true },
      current: { readOnlyHint: false },
    });
  }

  // destructiveHint: false → true is concerning (tool became destructive)
  if (baselineDestructive === false && currentDestructive === true) {
    changes.push({
      tool: toolName,
      class: 'annotation_changed',
      message: `Tool "${toolName}" destructiveHint changed from false to true (tool became destructive)`,
      previous: { destructiveHint: false },
      current: { destructiveHint: true },
    });
  }

  return changes;
}

/**
 * Filters changes to only those that should cause a failure
 * based on the fail_on configuration.
 */
export function filterFailingChanges(
  changes: DriftChange[],
  failOn: string[]
): DriftChange[] {
  const failOnSet = new Set(failOn);
  return changes.filter((change) => failOnSet.has(change.class));
}
