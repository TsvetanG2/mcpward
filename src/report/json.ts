/**
 * JSON reporter
 *
 * Outputs check results as machine-readable JSON.
 */

import type { CheckReport } from './model.js';

export interface JsonReporterOptions {
  pretty?: boolean;
}

/**
 * Renders a check report as JSON string.
 */
export function renderJsonReport(
  report: CheckReport,
  options: JsonReporterOptions = {}
): string {
  const { pretty = true } = options;

  if (pretty) {
    return JSON.stringify(report, null, 2);
  }

  return JSON.stringify(report);
}
