/**
 * Surface types for baseline lockfile and drift detection.
 */

import type { JsonSchema, ToolAnnotations } from '../checks/schema.js';

/**
 * Captured tool surface for lockfile storage.
 */
export interface ToolSurface {
  /** SHA-256 hash of the description for rug-pull detection */
  descriptionHash: string;

  /** Verbatim inputSchema for schema diff */
  inputSchema: JsonSchema | null;

  /** Verbatim outputSchema if present */
  outputSchema: JsonSchema | null;

  /** Tool annotations */
  annotations: Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'> | null;
}

// Re-export for convenience
export type { JsonSchema, ToolAnnotations };

/**
 * Server surface lockfile format.
 */
export interface ServerSurface {
  /** Protocol version negotiated at capture time */
  protocolVersion: string;

  /** Server capabilities at capture time */
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  };

  /** Captured tool surfaces keyed by tool name */
  tools: Record<string, ToolSurface>;

  /** Lockfile metadata */
  meta: {
    /** mcpward version that created this lockfile */
    mcpwardVersion: string;
    /** Timestamp of capture */
    capturedAt: string;
    /** Server name */
    serverName: string;
    /** Server version */
    serverVersion: string;
  };
}

/**
 * Drift change classes per SPEC.md §7.2
 */
export type DriftClass =
  | 'tool_removed'
  | 'tool_added'
  | 'description_changed'
  | 'breaking_schema_change'
  | 'nonbreaking_schema_change'
  | 'annotation_changed';

/**
 * A single drift finding.
 */
export interface DriftChange {
  /** Tool name affected */
  tool: string;

  /** Classification of the change */
  class: DriftClass;

  /** Human-readable description */
  message: string;

  /** Previous value (for diffs) */
  previous?: unknown;

  /** Current value (for diffs) */
  current?: unknown;
}

/**
 * Result of comparing two surfaces.
 */
export interface DriftResult {
  /** All detected changes */
  changes: DriftChange[];

  /** Is the server unchanged? */
  unchanged: boolean;
}
