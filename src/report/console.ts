/**
 * Console reporter
 *
 * Pretty-prints check results to the terminal.
 */

import pc from 'picocolors';
import type { CheckReport, CheckResult, CheckSummary } from './model.js';

const STATUS_ICONS: Record<string, string> = {
  pass: pc.green('✓'),
  fail: pc.red('✗'),
  warn: pc.yellow('⚠'),
  skip: pc.dim('○'),
};

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  error: pc.red,
  warning: pc.yellow,
  info: pc.dim,
};

export interface ConsoleReporterOptions {
  verbose?: boolean;
}

/**
 * Renders a check report to the console.
 */
export function renderConsoleReport(
  report: CheckReport,
  options: ConsoleReporterOptions = {}
): void {
  const { verbose = false } = options;

  // Header
  console.log('');
  console.log(pc.bold('mcpward'), pc.dim(`v${report.version}`));
  console.log(pc.dim('─'.repeat(50)));

  // Server info
  console.log(
    pc.bold('Server:'),
    report.server.name,
    pc.dim(`v${report.server.version}`)
  );
  console.log(pc.bold('Protocol:'), report.server.protocolVersion);
  console.log('');

  // Group results by family
  const byFamily = groupByFamily(report.results);

  for (const [family, results] of Object.entries(byFamily)) {
    renderFamily(family, results, verbose);
  }

  // Summary
  console.log('');
  renderSummary(report.summary);

  // Final status
  console.log('');
  if (report.summary.failed > 0) {
    console.log(pc.red(pc.bold(`${report.summary.failed} check(s) failed`)));
  } else if (report.summary.warnings > 0) {
    console.log(pc.yellow(pc.bold('All checks passed with warnings')));
  } else {
    console.log(pc.green(pc.bold('All checks passed')));
  }
}

function groupByFamily(
  results: CheckResult[]
): Record<string, CheckResult[]> {
  const groups: Record<string, CheckResult[]> = {};

  for (const result of results) {
    const family = result.family;
    const group = groups[family];
    if (group) {
      group.push(result);
    } else {
      groups[family] = [result];
    }
  }

  return groups;
}

function renderFamily(
  family: string,
  results: CheckResult[],
  verbose: boolean
): void {
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const passed = results.filter((r) => r.status === 'pass').length;

  // Family header with status indicator
  let familyStatus: string;
  if (failed > 0) {
    familyStatus = pc.red(`${failed} failed`);
  } else if (warned > 0) {
    familyStatus = pc.yellow(`${warned} warnings`);
  } else {
    familyStatus = pc.green(`${passed} passed`);
  }

  console.log(pc.bold(pc.cyan(family.toUpperCase())), pc.dim(`(${familyStatus})`));

  // Show results
  for (const result of results) {
    const shouldShow =
      verbose ||
      result.status === 'fail' ||
      result.status === 'warn';

    if (shouldShow) {
      renderResult(result, verbose);
    }
  }

  // If not verbose and all passed, show condensed view
  if (!verbose && failed === 0 && warned === 0) {
    console.log(pc.dim(`  ${passed} check(s) passed`));
  }

  console.log('');
}

function renderResult(result: CheckResult, verbose: boolean): void {
  const icon = STATUS_ICONS[result.status] ?? '?';
  const colorFn = SEVERITY_COLORS[result.severity] ?? ((s: string) => s);

  // Main line
  console.log(`  ${icon} ${colorFn(result.message)}`);

  // Location
  if (result.location) {
    console.log(pc.dim(`    at ${result.location}`));
  }

  // Expected/Actual for failures
  if ((result.status === 'fail' || verbose) && (result.expected !== undefined || result.actual !== undefined)) {
    if (result.expected !== undefined) {
      console.log(pc.dim(`    expected: ${formatValue(result.expected)}`));
    }
    if (result.actual !== undefined) {
      console.log(pc.dim(`    actual:   ${formatValue(result.actual)}`));
    }
  }
}

function renderSummary(summary: CheckSummary): void {
  const parts: string[] = [];

  if (summary.passed > 0) {
    parts.push(pc.green(`${summary.passed} passed`));
  }
  if (summary.failed > 0) {
    parts.push(pc.red(`${summary.failed} failed`));
  }
  if (summary.warnings > 0) {
    parts.push(pc.yellow(`${summary.warnings} warnings`));
  }
  if (summary.skipped > 0) {
    parts.push(pc.dim(`${summary.skipped} skipped`));
  }

  console.log(pc.bold('Summary:'), parts.join(pc.dim(' | ')));
  console.log(pc.dim(`Total: ${summary.total} checks`));
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
