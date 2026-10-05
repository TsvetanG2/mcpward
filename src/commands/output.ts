/**
 * Shared output path for `run` and `diff`: report assembly, reporters, PR comment, and the
 * whole-run deadline. One implementation, so the two commands cannot drift apart.
 */

import { writeFile } from 'node:fs/promises';
import pc from 'picocolors';
import type { McpConnection } from '../client/connect.js';
import {
  type CheckResult,
  type CheckReport,
  summarizeResults,
  REPORT_SCHEMA_VERSION,
} from '../report/model.js';
import { renderConsoleReport } from '../report/console.js';
import { renderJsonReport } from '../report/json.js';
import { renderSarifReport } from '../report/sarif.js';
import { renderJunitReport } from '../report/junit.js';
import { renderMarkdownReport } from '../report/markdown.js';
import { detectPrContext, upsertPrComment } from '../report/github.js';
import { redactReport } from '../report/redact.js';
import { MCPWARD_VERSION } from '../version.js';

export interface OutputOptions {
  /** console | json | junit | sarif | markdown */
  reporter: string;
  out?: string;
  verbose?: boolean;
}

export type PrContextResult = ReturnType<typeof detectPrContext>;

/** Builds the report model from results. */
export function buildReport(connection: McpConnection, results: CheckResult[]): CheckReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    version: MCPWARD_VERSION,
    timestamp: new Date().toISOString(),
    server: {
      name: connection.serverInfo.name,
      version: connection.serverInfo.version,
      protocolVersion: connection.protocolVersion,
    },
    summary: summarizeResults(results),
    results,
  };
}

const RENDERERS: Record<string, { render: (r: CheckReport) => string; label: string }> = {
  json: { render: renderJsonReport, label: 'Report' },
  sarif: { render: renderSarifReport, label: 'SARIF report' },
  junit: { render: renderJunitReport, label: 'JUnit report' },
  markdown: { render: renderMarkdownReport, label: 'Markdown report' },
};

/**
 * Redacts the report, then renders it with the chosen reporter (stdout or `out`).
 * Redaction happens here so no caller can render an unredacted report.
 */
export async function emitReport(report: CheckReport, options: OutputOptions): Promise<void> {
  redactReport(report);

  const renderer = RENDERERS[options.reporter];
  if (!renderer) {
    renderConsoleReport(report, { verbose: options.verbose ?? false });
    return;
  }

  const text = renderer.render(report);
  if (options.out) {
    await writeFile(options.out, text, 'utf-8');
    console.log(pc.dim(`${renderer.label} written to ${options.out}`));
  } else {
    console.log(text);
  }
}

/**
 * Posts the (already redacted) report as a PR comment. Never changes the exit code and never
 * writes to stdout — a machine-readable report on stdout must stay parseable.
 */
export async function publishPrComment(report: CheckReport, ctx: PrContextResult): Promise<void> {
  if ('reason' in ctx) {
    console.error(pc.dim(`PR comment skipped: ${ctx.reason}`));
    return;
  }
  try {
    const outcome = await upsertPrComment(ctx, renderMarkdownReport(report));
    console.error(pc.dim(`PR comment ${outcome} on ${ctx.repo}#${ctx.prNumber}`));
  } catch (err) {
    console.error(
      pc.yellow('Warning: could not post PR comment:'),
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Returns a close function that always hands back the SAME promise.
 *
 * The run deadline closes the connection without awaiting it; command cleanup closes it again.
 * A second SDK close returns immediately, so without memoization cleanup would not wait for
 * the first one — and the CLI's process.exit would run before the SDK finishes terminating the
 * server (SIGTERM, then SIGKILL), leaving a timed-out server process alive.
 */
export function closeOnce(connection: McpConnection): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    // Memoize the ORIGINAL promise: callers that ignore close errors catch at the call site,
    // callers that care (baseline) still see the failure.
    closing ??= connection.close();
    return closing;
  };
}

/** Thrown when the whole run exceeds `timeouts.run_ms`. */
export class RunDeadlineError extends Error {
  constructor(readonly ms: number) {
    super(`Run exceeded timeouts.run_ms (${ms}ms) — results are incomplete`);
    this.name = 'RunDeadlineError';
  }
}

/**
 * Races `work` against the whole-run deadline. On expiry the deadline rejects FIRST, then
 * `onExpire` runs (close the connection so in-flight calls stop). The order matters: closing
 * first lets the checks fail fast and "finish", and the race would report that as a result.
 */
export async function withRunDeadline<T>(
  work: Promise<T>,
  ms: number,
  onExpire: () => Promise<void>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RunDeadlineError(ms));
      void onExpire().catch(() => undefined);
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
