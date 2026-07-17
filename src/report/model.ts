/**
 * Normalized check result model.
 * All checks produce this same structure. Reporters only read this model.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export type CheckFamily =
  | 'compliance'
  | 'schema'
  | 'drift'
  | 'security'
  | 'behavioral'
  | 'errors'
  | 'latency';

export type Severity = 'error' | 'warning' | 'info';

export interface CheckResult {
  /** Unique identifier for this check, e.g. "compliance/handshake" */
  id: string;

  /** Check family this belongs to */
  family: CheckFamily;

  /** Pass/fail/warn/skip status */
  status: CheckStatus;

  /** Severity level for failures */
  severity: Severity;

  /** Human-readable message describing the result */
  message: string;

  /** Expected value (for diff display) */
  expected?: unknown;

  /** Actual value (for diff display) */
  actual?: unknown;

  /** Location information (file path, line number, tool name, etc.) */
  location?: string;
}

export interface CheckSummary {
  /** Total number of checks run */
  total: number;

  /** Number of passed checks */
  passed: number;

  /** Number of failed checks */
  failed: number;

  /** Number of warnings */
  warnings: number;

  /** Number of skipped checks */
  skipped: number;
}

export interface CheckReport {
  /** mcpward version */
  version: string;

  /** Timestamp of the run */
  timestamp: string;

  /** Server information */
  server: {
    name: string;
    version: string;
    protocolVersion: string;
  };

  /** Summary counts */
  summary: CheckSummary;

  /** All check results */
  results: CheckResult[];
}

/**
 * Creates a summary from check results.
 */
export function summarizeResults(results: CheckResult[]): CheckSummary {
  return {
    total: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    warnings: results.filter((r) => r.status === 'warn').length,
    skipped: results.filter((r) => r.status === 'skip').length,
  };
}

/**
 * Determines exit code from check results.
 * 0 = all pass, 1 = one or more failed, 2 = config/connection error (handled elsewhere)
 */
export function getExitCode(results: CheckResult[]): number {
  const hasFailed = results.some((r) => r.status === 'fail');
  return hasFailed ? 1 : 0;
}
