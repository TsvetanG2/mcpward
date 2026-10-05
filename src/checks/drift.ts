/**
 * Drift checks
 *
 * Detects changes between baseline lockfile and current server surface.
 * Classifies changes according to the drift truth table and respects fail_on config.
 */

import { existsSync } from 'fs';
import type { CheckResult, Severity } from '../report/model.js';
import type { McpConnection } from '../client/connect.js';
import type { Config, DriftConfig } from '../config/schema.js';
import {
  captureSurface,
  loadLockfile,
  diffSurfaces,
  filterFailingChanges,
  applySeverityOverrides,
  type DriftChange,
  type DriftSeverity,
  type SamplingNote,
} from '../surface/index.js';

export interface DriftCheckContext {
  connection: McpConnection;
  /** Full config (needed for captureServerSurface) */
  fullConfig: Config;
  /** Drift-specific config (for backwards compat) */
  config?: DriftConfig;
}

/**
 * Maps drift severity to CheckResult severity (M2).
 *
 * CRITICAL: Do NOT conflate these two severities:
 * - DriftSeverity: blast radius of the contract change (high/medium/low)
 * - CheckResult.Severity: reporting level (error/warning/info)
 *
 * They are separate axes. The mapping is deliberate:
 * - high (silent security changes) → error
 * - medium (loud schema breaks) → warning
 * - low (visible changes) → info
 */
function mapDriftSeverityToCheckSeverity(driftSeverity: DriftSeverity): Severity {
  switch (driftSeverity) {
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
      return 'info';
  }
}

/**
 * Converts a drift change to a CheckResult.
 */
function changeToResult(
  change: DriftChange,
  shouldFail: boolean
): CheckResult {
  const baseSeverity = mapDriftSeverityToCheckSeverity(change.severity);

  return {
    id: `drift/${change.class}`,
    family: 'drift',
    status: shouldFail ? 'fail' : (baseSeverity === 'error' ? 'warn' : 'pass'),
    severity: shouldFail ? 'error' : baseSeverity,
    message: change.message,
    expected: change.previous,
    actual: change.current,
    location: change.tool,
  };
}

/**
 * Converts an output-sampling note (M3) to a CheckResult.
 * Refused/skipped calls are expected policy outcomes (skip); failures are warnings.
 */
export function noteToResult(note: SamplingNote): CheckResult {
  const isProblem = note.status === 'failed' || note.status === 'partial';
  return {
    id: 'drift/output-sampling',
    family: 'drift',
    status: isProblem ? 'warn' : 'skip',
    severity: isProblem ? 'warning' : 'info',
    message: `Output sampling ${note.status} for "${note.tool}": ${note.reason}`,
    location: note.tool,
  };
}

/**
 * Runs drift checks against the baseline lockfile.
 */
export async function runDriftChecks(
  ctx: DriftCheckContext
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const baselinePath = ctx.config?.baseline ?? './mcpward.lock.json';
  const failOn = ctx.config?.fail_on ?? [
    'tool_removed',
    'description_changed',
    'breaking_schema_change',
    'annotation_changed',
    'breaking_output_shape_change',
  ];

  // Check if baseline exists
  if (!existsSync(baselinePath)) {
    results.push({
      id: 'drift/baseline-missing',
      family: 'drift',
      status: 'skip',
      severity: 'warning',
      message: `Baseline file not found: ${baselinePath}. Run 'mcpward baseline' first.`,
      expected: 'Baseline lockfile',
      actual: 'File not found',
    });
    return results;
  }

  // Load baseline
  let baseline;
  try {
    baseline = await loadLockfile(baselinePath);
  } catch (err) {
    results.push({
      id: 'drift/baseline-invalid',
      family: 'drift',
      status: 'fail',
      severity: 'error',
      message: `Failed to load baseline: ${err instanceof Error ? err.message : String(err)}`,
      expected: 'Valid JSON lockfile',
      actual: err instanceof Error ? err.message : String(err),
    });
    return results;
  }

  // Capture current surface
  let current;
  let notes: SamplingNote[];
  try {
    ({ surface: current, notes } = await captureSurface(ctx.connection, ctx.fullConfig));
  } catch (err) {
    results.push({
      id: 'drift/capture-failed',
      family: 'drift',
      status: 'fail',
      severity: 'error',
      message: `Failed to capture server surface: ${err instanceof Error ? err.message : String(err)}`,
      actual: err instanceof Error ? err.message : String(err),
    });
    return results;
  }

  // Check for auth context mismatch (M1 - auth-scoped baselines)
  const baselineFingerprint = baseline.meta.authContext?.fingerprint;
  const currentFingerprint = current.meta.authContext?.fingerprint;

  if (
    baselineFingerprint &&
    currentFingerprint &&
    baselineFingerprint !== currentFingerprint
  ) {
    // Different auth contexts - warn that drift may be noise
    const baselineLabel = baseline.meta.authContext?.label || 'unlabeled';
    const currentLabel = current.meta.authContext?.label || 'unlabeled';

    results.push({
      id: 'drift/auth-context-mismatch',
      family: 'drift',
      status: 'warn',
      severity: 'warning',
      message:
        `Auth context mismatch: baseline captured under "${baselineLabel}", ` +
        `current under "${currentLabel}". Drift may be due to different permissions.`,
      expected: baselineFingerprint,
      actual: currentFingerprint,
    });
  }

  // Output sampling notes (M3): refused/skipped tools are reported, never silently dropped
  results.push(...notes.map(noteToResult));

  // Diff surfaces, then apply user severity overrides
  const diff = diffSurfaces(baseline, current);
  diff.changes = applySeverityOverrides(diff.changes, ctx.config?.severity);

  // If no changes, report success
  if (diff.unchanged) {
    results.push({
      id: 'drift/no-changes',
      family: 'drift',
      status: 'pass',
      severity: 'info',
      message: 'No drift detected. Server surface matches baseline.',
    });
    return results;
  }

  // Determine which changes should fail
  const failingChanges = filterFailingChanges(diff.changes, failOn);
  const failingSet = new Set(failingChanges);

  // Convert all changes to results
  for (const change of diff.changes) {
    const shouldFail = failingSet.has(change);
    results.push(changeToResult(change, shouldFail));
  }

  // Add summary
  const failCount = failingChanges.length;
  const totalCount = diff.changes.length;

  if (failCount > 0) {
    results.unshift({
      id: 'drift/summary',
      family: 'drift',
      status: 'fail',
      severity: 'error',
      message: `Drift detected: ${failCount} failing change(s) out of ${totalCount} total`,
      expected: 'No breaking changes',
      actual: `${failCount} breaking, ${totalCount - failCount} non-breaking`,
    });
  } else {
    results.unshift({
      id: 'drift/summary',
      family: 'drift',
      status: 'pass',
      severity: 'info',
      message: `Drift detected: ${totalCount} non-breaking change(s)`,
    });
  }

  return results;
}
