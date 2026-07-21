/**
 * JUnit XML reporter
 *
 * Generates JUnit XML output for CI integration (GitHub Actions, Jenkins, etc.)
 *
 * @see https://llg.cubic.org/docs/junit/
 */

import type { CheckResult, CheckReport } from './model.js';

/**
 * Escapes XML special characters.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Converts a CheckResult to a JUnit test case.
 */
function resultToTestCase(result: CheckResult): string {
  const name = escapeXml(result.message);
  const classname = escapeXml(result.id);
  const time = '0.001'; // We don't track individual check time

  let content = '';

  if (result.status === 'fail') {
    const message = escapeXml(result.message);
    const details = formatDetails(result);
    content = `      <failure message="${message}" type="AssertionError"><![CDATA[${details}]]></failure>\n`;
  } else if (result.status === 'warn') {
    const message = escapeXml(result.message);
    content = `      <system-out><![CDATA[WARNING: ${message}]]></system-out>\n`;
  }

  return `    <testcase name="${name}" classname="${classname}" time="${time}">\n${content}    </testcase>`;
}

/**
 * Formats check details for failure message.
 */
function formatDetails(result: CheckResult): string {
  const lines: string[] = [];

  if (result.location) {
    lines.push(`Location: ${result.location}`);
  }
  if (result.expected !== undefined) {
    lines.push(`Expected: ${JSON.stringify(result.expected)}`);
  }
  if (result.actual !== undefined) {
    lines.push(`Actual: ${JSON.stringify(result.actual)}`);
  }

  return lines.join('\n');
}

/**
 * Groups results by family for test suites.
 */
function groupByFamily(results: CheckResult[]): Map<string, CheckResult[]> {
  const groups = new Map<string, CheckResult[]>();

  for (const result of results) {
    const family = result.family;
    const existing = groups.get(family);
    if (existing) {
      existing.push(result);
    } else {
      groups.set(family, [result]);
    }
  }

  return groups;
}

/**
 * Renders a JUnit XML report from check results.
 */
export function renderJunitReport(report: CheckReport): string {
  const groups = groupByFamily(report.results);
  const suites: string[] = [];

  let totalTests = 0;
  let totalFailures = 0;
  let totalErrors = 0;
  let totalSkipped = 0;

  for (const [family, results] of groups) {
    const tests = results.length;
    const failures = results.filter((r) => r.status === 'fail').length;
    const errors = 0; // We don't distinguish errors from failures
    const skipped = results.filter((r) => r.status === 'skip').length;

    totalTests += tests;
    totalFailures += failures;
    totalErrors += errors;
    totalSkipped += skipped;

    const testCases = results.map(resultToTestCase).join('\n');

    suites.push(`  <testsuite name="${escapeXml(family)}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="0.001">
${testCases}
  </testsuite>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="mcpward" tests="${totalTests}" failures="${totalFailures}" errors="${totalErrors}" skipped="${totalSkipped}" time="0.001">
${suites.join('\n')}
</testsuites>`;

  return xml;
}
