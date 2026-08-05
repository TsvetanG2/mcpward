/**
 * Surface types for baseline lockfile and drift detection.
 */

import type { JsonSchema, ToolAnnotations } from '../checks/schema.js';

/**
 * Captured tool surface for lockfile storage.
 */
export interface ToolSurface {
  /** SHA-256 hash of the canonical description for rug-pull detection */
  descriptionHash: string;

  /**
   * Full canonical description text for rendering before/after diffs.
   * Null when capture.full_text config is disabled.
   * Added in lockfile v2 (M1).
   */
  description: string | null;

  /** Canonical inputSchema for schema diff */
  inputSchema: JsonSchema | null;

  /** Canonical outputSchema if present */
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
    /**
     * Lockfile schema version. Incremented when format changes.
     * v1: Initial format (no schemaVersion field)
     * v2: Added target, authContext, environment, description storage (M1)
     */
    schemaVersion: 2;

    /** mcpward version that created this lockfile */
    mcpwardVersion: string;

    /**
     * Canonicalization version used when creating this lockfile.
     * When this differs from the current canonicalization version, diff warns
     * that the comparison crosses a canonicalization change and recommends re-baselining.
     */
    canonicalVersion: number;

    /** Timestamp of capture (ISO 8601) */
    capturedAt: string;

    /** Server name from serverInfo */
    serverName: string;

    /** Server version from serverInfo */
    serverVersion: string;

    /**
     * Target server identity - what was connected to.
     * Added in v2 (M1 - provenance tracking).
     */
    target: {
      /** Transport type used */
      transport: 'stdio' | 'http';
      /**
       * Stable identity of the server target.
       * stdio: command + args, NO env values (e.g., "npx @modelcontextprotocol/server-filesystem /tmp")
       * http: origin + path, NO query string, NO headers (e.g., "https://api.example.com/mcp")
       */
      identity: string;
    };

    /**
     * Authentication context - how auth was supplied and fingerprint.
     * Added in v2 (M1 - auth-scoped baselines).
     */
    authContext: {
      /** How auth was supplied */
      kind: 'none' | 'env' | 'header' | 'unknown';
      /**
       * Names of auth-bearing env vars or headers.
       * NAMES ONLY, NEVER VALUES - values would leak secrets into lockfile.
       * Example: ["OPENAI_API_KEY"] or ["Authorization"]
       */
      keys: string[];
      /**
       * Stable non-reversible fingerprint of the credential material.
       * sha256(credential + serverIdentity) truncated to 16 hex chars.
       * Allows detecting "same credential as last time" without storing secrets.
       * Null when no auth or fingerprinting fails.
       */
      fingerprint: string | null;
      /**
       * Optional user-declared label for this auth context.
       * Example: "ci-readonly", "admin", "development"
       */
      label: string | null;
    };

    /**
     * Environment where the capture was performed.
     * Added in v2 (M1 - provenance tracking).
     */
    environment: {
      /** Running in CI environment (detected from CI env var) */
      ci: boolean;
      /** Node.js version (process.version) */
      nodeVersion: string;
      /** Platform (process.platform) */
      platform: string;
    };
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
 * Drift severity levels based on blast radius (M2).
 *
 * Severity describes the security/operational impact of a change, NOT whether it breaks.
 * This is a SEPARATE axis from drift class.
 *
 * - high: Changes that affect client security or auto-approval behavior (permission expansion,
 *   rug-pull descriptions, readOnlyHint flips)
 * - medium: Changes that break loudly at the call site (schema breaks, output shape changes)
 * - low: Changes that are visible and expected (tool added/removed, optional params)
 */
export type DriftSeverity = 'high' | 'medium' | 'low';

/**
 * A single drift finding.
 */
export interface DriftChange {
  /** Tool name affected */
  tool: string;

  /** Classification of the change */
  class: DriftClass;

  /**
   * Severity level based on blast radius (M2).
   * Separate from breaking/non-breaking - a removed tool is breaking but low severity
   * because it fails loudly and gets fixed in minutes. A readOnlyHint flip is high severity
   * because it silently changes what clients auto-approve.
   */
  severity: DriftSeverity;

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
