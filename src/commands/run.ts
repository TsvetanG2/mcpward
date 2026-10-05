import { writeFile } from 'node:fs/promises';
import pc from 'picocolors';
import { connect } from '../client/connect.js';
import { runComplianceChecks } from '../checks/compliance.js';
import { runSchemaChecks } from '../checks/schema.js';
import { runDriftChecks } from '../checks/drift.js';
import { runSecurityChecks } from '../checks/security.js';
import { runBehavioralChecks } from '../checks/behavioral.js';
import { runErrorContractChecks } from '../checks/errors.js';
import { runLatencyChecks } from '../checks/latency.js';
import { runCollisionChecks } from '../checks/collision.js';
import {
  type CheckResult,
  type CheckReport,
  summarizeResults,
  getExitCode,
} from '../report/model.js';
import { renderConsoleReport } from '../report/console.js';
import { renderJsonReport } from '../report/json.js';
import { renderSarifReport } from '../report/sarif.js';
import { renderJunitReport } from '../report/junit.js';
import { renderMarkdownReport } from '../report/markdown.js';
import { detectPrContext, upsertPrComment } from '../report/github.js';
import { redactReport } from '../report/redact.js';
import type { Config } from '../config/schema.js';
import { MCPWARD_VERSION } from '../version.js';

export interface RunOptions {
  config: string;
  reporter: string;
  out?: string;
  json?: boolean;
  verbose?: boolean;
  /** Post/update the report as a GitHub PR comment (M5). Opt-in. */
  prComment?: boolean;
}

export async function runCommand(
  config: Config,
  options: RunOptions
): Promise<number> {
  const verbose = options.verbose ?? false;
  const reporter = options.json ? 'json' : options.reporter;

  if (verbose) {
    console.log(pc.dim('Connecting to server...'));
  }

  let connection;
  try {
    connection = await connect(config);
  } catch (err) {
    console.error(
      pc.red('Failed to connect:'),
      err instanceof Error ? err.message : err
    );
    return 2;
  }

  // Setup signal handlers for cleanup
  let interrupted = false;
  const cleanup = async () => {
    if (!interrupted) {
      interrupted = true;
      if (verbose) {
        console.log(pc.dim('\nInterrupted, cleaning up...'));
      }
      try {
        await connection.close();
      } catch {
        // Ignore close errors during signal handling
      }
      process.exit(130); // Standard exit code for SIGINT
    }
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    const results: CheckResult[] = [];

    // Run compliance checks if enabled
    if (config.checks?.compliance !== false) {
      if (verbose) {
        console.log(pc.dim('Running compliance checks...'));
      }
      const complianceResults = await runComplianceChecks({
        connection,
        config,
      });
      results.push(...complianceResults);
    }

    // Run schema checks if enabled
    if (config.checks?.schema !== false) {
      if (verbose) {
        console.log(pc.dim('Running schema checks...'));
      }
      const schemaResults = await runSchemaChecks({
        connection,
      });
      results.push(...schemaResults);
    }

    // Run drift checks if enabled and baseline exists
    if (config.checks?.drift) {
      if (verbose) {
        console.log(pc.dim('Running drift checks...'));
      }
      const driftResults = await runDriftChecks({
        connection,
        fullConfig: config,
        config: config.checks.drift,
      });
      results.push(...driftResults);
    }

    // Run security checks if enabled
    if (config.checks?.security !== false) {
      if (verbose) {
        console.log(pc.dim('Running security checks...'));
      }
      const securityResults = await runSecurityChecks({
        connection,
      });
      results.push(...securityResults);
    }

    // Run description collision lint (M4) — on by default, needs no baseline
    if (config.checks?.collision?.enabled !== false) {
      if (verbose) {
        console.log(pc.dim('Running collision lint...'));
      }
      const collisionResults = await runCollisionChecks({
        connection,
        config: config.checks?.collision,
      });
      results.push(...collisionResults);
    }

    // Run behavioral test suites if defined
    if (config.suites && config.suites.length > 0) {
      if (verbose) {
        console.log(pc.dim('Running behavioral test suites...'));
      }
      const behavioralResults = await runBehavioralChecks({
        connection,
        suites: config.suites,
      });
      results.push(...behavioralResults);
    }

    // Run error contract checks
    if (verbose) {
      console.log(pc.dim('Running error contract checks...'));
    }
    const errorResults = await runErrorContractChecks({
      connection,
    });
    results.push(...errorResults);

    // Run latency checks if configured
    if (config.checks?.latency) {
      if (verbose) {
        console.log(pc.dim('Running latency checks...'));
      }
      const latencyResults = await runLatencyChecks({
        connection,
        config: config.checks.latency,
      });
      results.push(...latencyResults);
    }

    // Build report
    const report: CheckReport = {
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

    // Redact secrets before rendering (applies to all reporters)
    redactReport(report);

    // Output report
    if (reporter === 'json') {
      const json = renderJsonReport(report);
      if (options.out) {
        await writeFile(options.out, json, 'utf-8');
        console.log(pc.dim(`Report written to ${options.out}`));
      } else {
        console.log(json);
      }
    } else if (reporter === 'sarif') {
      const sarif = renderSarifReport(report);
      if (options.out) {
        await writeFile(options.out, sarif, 'utf-8');
        console.log(pc.dim(`SARIF report written to ${options.out}`));
      } else {
        console.log(sarif);
      }
    } else if (reporter === 'markdown') {
      const markdown = renderMarkdownReport(report);
      if (options.out) {
        await writeFile(options.out, markdown, 'utf-8');
        console.log(pc.dim(`Markdown report written to ${options.out}`));
      } else {
        console.log(markdown);
      }
    } else if (reporter === 'junit') {
      const junit = renderJunitReport(report);
      if (options.out) {
        await writeFile(options.out, junit, 'utf-8');
        console.log(pc.dim(`JUnit report written to ${options.out}`));
      } else {
        console.log(junit);
      }
    } else {
      // Console reporter
      renderConsoleReport(report, { verbose });
    }

    if (options.prComment) {
      await publishPrComment(report);
    }

    return getExitCode(results);
  } finally {
    // Remove signal handlers
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
    // Only close if not already closed by signal handler
    if (!interrupted) {
      try {
        await connection.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Posts the (already redacted) report as a PR comment. Never changes the exit code and never
 * writes to stdout — a machine-readable report on stdout must stay parseable.
 */
async function publishPrComment(report: CheckReport): Promise<void> {
  const ctx = detectPrContext();
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
