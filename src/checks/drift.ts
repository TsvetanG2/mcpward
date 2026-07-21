/**
 * Drift checks
 *
 * Detects changes between baseline lockfile and current server surface.
 * Classifies changes according to the drift truth table and respects fail_on config.
 */

import { existsSync } from 'fs';
import type { CheckResult } from '../report/model.js';
import type { McpConnection } from '../client/connect.js';
import type { DriftConfig } from '../config/schema.js';
import {
  captureServerSurface,
  loadLockfile,
  diffSurfaces,
  filterFailingChanges,
  type DriftChange,
  type DriftClass,
} from '../surface/index.js';

export interface DriftCheckContext {
  connection: McpConnection;
  config?: DriftConfig;
}

/**
 * Maps drift classes to severity levels.
 */
function getSeverity(driftClass: DriftClass): 'error' | 'warning' | 'info' {
  switch (driftClass) {
    case 'tool_removed':
    case 'description_changed':
    case 'breaking_schema_change':
    case 'annotation_changed':
      return 'error';
    case 'tool_added':
    case 'nonbreaking_schema_change':
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
  const severity = getSeverity(change.class);

  return {
    id: `drift/${change.class}`,
    family: 'drift',
    status: shouldFail ? 'fail' : (severity === 'error' ? 'warn' : 'pass'),
    severity: shouldFail ? 'error' : severity,
    message: change.message,
    expected: change.previous,
    actual: change.current,
    location: change.tool,
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
  try {
    current = await captureServerSurface(ctx.connection);
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

  // Diff surfaces
  const diff = diffSurfaces(baseline, current);

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
