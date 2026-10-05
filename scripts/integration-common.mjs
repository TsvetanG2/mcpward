/**
 * Shared utilities for integration baseline capture and comparison.
 */

/**
 * Normalizes a finding for stable comparison.
 *
 * @param {object} finding - Raw CheckResult from mcpward report
 * @returns {object} Normalized finding with stable identity
 */
export function normalizeFinding(finding) {
  // Locations are deterministic (the unknown-tool probe uses a fixed name since v0.4.0),
  // so no normalization is needed beyond picking the stable fields.
  return {
    family: finding.family,
    id: finding.id,
    status: finding.status,
    location: finding.location,
  };
}

/**
 * Normalizes a full mcpward JSON report to extract stable finding identities.
 *
 * - Drops all pass results (only fail/warn/skip matter for baseline)
 * - Strips timestamp, expected, actual (run-specific noise)
 * - Keeps only stable identity fields (family, id, status, location)
 * - Sorts findings deterministically
 *
 * @param {object} report - Full CheckReport from mcpward
 * @returns {Array<object>} Sorted array of normalized findings
 */
export function normalizeReport(report) {
  if (!report || !report.results) {
    return [];
  }

  // Filter to non-pass results only
  const nonPassResults = report.results.filter((r) => r.status !== 'pass');

  // Normalize each finding
  const normalized = nonPassResults.map(normalizeFinding);

  // Sort deterministically by: family, id, status, location
  normalized.sort((a, b) => {
    // Compare family
    if (a.family < b.family) return -1;
    if (a.family > b.family) return 1;

    // Compare id
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;

    // Compare status
    if (a.status < b.status) return -1;
    if (a.status > b.status) return 1;

    // Compare location (nulls sort first)
    const locA = a.location ?? '';
    const locB = b.location ?? '';
    if (locA < locB) return -1;
    if (locB > locA) return 1;

    return 0;
  });

  return normalized;
}

/**
 * Computes set difference between actual and baseline findings.
 *
 * @param {Array<object>} actual - Normalized findings from fresh run
 * @param {Array<object>} baseline - Normalized findings from committed baseline
 * @returns {object} { added: [...], missing: [...], match: boolean }
 */
export function compareFindings(actual, baseline) {
  // Convert to sets using JSON string as key (simple but effective)
  const actualSet = new Set(actual.map((f) => JSON.stringify(f)));
  const baselineSet = new Set(baseline.map((f) => JSON.stringify(f)));

  const added = [];
  for (const item of actualSet) {
    if (!baselineSet.has(item)) {
      added.push(JSON.parse(item));
    }
  }

  const missing = [];
  for (const item of baselineSet) {
    if (!actualSet.has(item)) {
      missing.push(JSON.parse(item));
    }
  }

  return {
    added,
    missing,
    match: added.length === 0 && missing.length === 0,
  };
}
