/**
 * Console reporter
 *
 * Pretty-prints check results to the terminal.
 */

import pc from 'picocolors';
import type { CheckReport, CheckResult, CheckSummary } from './model.js';
import { wordDiff, markInvisibleCharacters } from './text-diff.js';

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
  console.log(pc.bold('Server:'), report.server.name, pc.dim(`v${report.server.version}`));
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

function groupByFamily(results: CheckResult[]): Record<string, CheckResult[]> {
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

function renderFamily(family: string, results: CheckResult[], verbose: boolean): void {
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
    const shouldShow = verbose || result.status === 'fail' || result.status === 'warn';

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

  // M2.4: Special rendering for description diffs
  const isDescriptionChanged = result.id === 'drift/description_changed';
  const isHash = (v: unknown) => typeof v === 'string' && DESCRIPTION_HASH.test(v);
  const hasDescriptionText =
    isDescriptionChanged &&
    typeof result.expected === 'string' &&
    typeof result.actual === 'string' &&
    !isHash(result.expected) &&
    !isHash(result.actual);

  if (isDescriptionChanged && !hasDescriptionText) {
    // Lockfile has no text for one side (full_text: false, or a v1 baseline)
    console.log(
      pc.dim(
        '    full text unavailable (full_text disabled or v1 baseline) — re-run "mcpward baseline" to enable a diff'
      )
    );
  }

  if (hasDescriptionText) {
    renderDescriptionDiff(result.expected as string, result.actual as string);
  } else if (
    (result.status === 'fail' || verbose) &&
    (result.expected !== undefined || result.actual !== undefined)
  ) {
    // Standard expected/actual formatting
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

/** Shape of a stored description hash (see hashDescription in surface/capture.ts). */
const DESCRIPTION_HASH = /^sha256:[0-9a-f]{64}$/;

/** Console cap per side; the JSON report always carries the full text. */
const MAX_DESCRIPTION_CHARS = 200;

/**
 * Renders a description change (M2.4): a single word-level diff line (removed `[-…-]`,
 * added `{+…+}`, so it stays readable with NO_COLOR), falling back to before/after when the
 * text is too long. Invisible characters are always marked, never printed raw.
 */
function renderDescriptionDiff(previous: string, current: string): void {
  const segments =
    previous.length <= MAX_DESCRIPTION_CHARS && current.length <= MAX_DESCRIPTION_CHARS
      ? wordDiff(previous, current)
      : null;

  if (segments) {
    const line = segments
      .map((seg) => {
        const text = markInvisibleCharacters(seg.text);
        if (seg.kind === 'removed') return pc.red(`[-${text}-]`);
        if (seg.kind === 'added') return pc.green(`{+${text}+}`);
        return text;
      })
      .join('');
    console.log(pc.dim('    description diff:'));
    console.log(`      ${line}`);
    return;
  }

  console.log(pc.dim('    previous description:'));
  console.log(
    pc.red(`      ${markInvisibleCharacters(truncateText(previous, MAX_DESCRIPTION_CHARS))}`)
  );
  console.log(pc.dim('    current description:'));
  console.log(
    pc.green(`      ${markInvisibleCharacters(truncateText(current, MAX_DESCRIPTION_CHARS))}`)
  );
}

/**
 * Truncates text to max length with ellipsis.
 * Used for description diffs to keep console output readable.
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '… (truncated, see JSON report for full text)';
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
