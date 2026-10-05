import { dirname, resolve } from 'node:path';
import pc from 'picocolors';
import { connect, type McpConnection } from '../client/connect.js';
import { runComplianceChecks } from '../checks/compliance.js';
import { runSchemaChecks } from '../checks/schema.js';
import { runDriftChecks } from '../checks/drift.js';
import { runSecurityChecks } from '../checks/security.js';
import { runBehavioralChecks, type GoldenOptions } from '../checks/behavioral.js';
import { runErrorContractChecks } from '../checks/errors.js';
import { runLatencyChecks } from '../checks/latency.js';
import { runCollisionChecks } from '../checks/collision.js';
import { type CheckResult, getExitCode } from '../report/model.js';
import { detectPrContext } from '../report/github.js';
import type { Config } from '../config/schema.js';
import {
  buildReport,
  emitReport,
  publishPrComment,
  withRunDeadline,
  RunDeadlineError,
  closeOnce,
} from './output.js';

export interface RunOptions {
  config: string;
  reporter: string;
  out?: string;
  json?: boolean;
  verbose?: boolean;
  /** Post/update the report as a GitHub PR comment (M5). Opt-in. */
  prComment?: boolean;
  /** Write golden snapshot files instead of comparing against them (M6.2). */
  updateGolden?: boolean;
}

/** Default whole-run budget when the config has no `timeouts` section. */
export const DEFAULT_RUN_MS = 300000;

/**
 * Runs every enabled check family against an open connection.
 */
async function runAllChecks(
  connection: McpConnection,
  config: Config,
  verbose: boolean,
  golden: GoldenOptions
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const step = (label: string) => {
    if (verbose) console.log(pc.dim(`Running ${label}...`));
  };

  if (config.checks?.compliance !== false) {
    step('compliance checks');
    results.push(...(await runComplianceChecks({ connection, config })));
  }

  if (config.checks?.schema !== false) {
    step('schema checks');
    results.push(...(await runSchemaChecks({ connection })));
  }

  if (config.checks?.drift) {
    step('drift checks');
    results.push(
      ...(await runDriftChecks({ connection, fullConfig: config, config: config.checks.drift }))
    );
  }

  if (config.checks?.security !== false) {
    step('security checks');
    results.push(...(await runSecurityChecks({ connection })));
  }

  // Description collision lint (M4) — on by default, needs no baseline
  if (config.checks?.collision?.enabled !== false) {
    step('collision lint');
    results.push(
      ...(await runCollisionChecks({ connection, config: config.checks?.collision }))
    );
  }

  if (config.suites && config.suites.length > 0) {
    step('behavioral test suites');
    results.push(...(await runBehavioralChecks({ connection, suites: config.suites, golden })));
  }

  step('error contract checks');
  results.push(...(await runErrorContractChecks({ connection })));

  if (config.checks?.latency) {
    step('latency checks');
    results.push(...(await runLatencyChecks({ connection, config: config.checks.latency })));
  }

  return results;
}

export async function runCommand(config: Config, options: RunOptions): Promise<number> {
  const verbose = options.verbose ?? false;
  const reporter = options.json ? 'json' : options.reporter;

  // Detect the PR context FIRST: it registers the GitHub token as a secret, and that must
  // happen before any server output is redacted or rendered.
  const prContext = options.prComment ? detectPrContext() : undefined;

  if (verbose) {
    console.log(pc.dim('Connecting to server...'));
  }

  let connection: McpConnection;
  try {
    connection = await connect(config);
  } catch (err) {
    console.error(pc.red('Failed to connect:'), err instanceof Error ? err.message : err);
    return 2;
  }

  // One shared close: the deadline, signal handlers and cleanup all await the same shutdown
  const close = closeOnce(connection);
  const onSignal = async () => {
    if (verbose) {
      console.log(pc.dim('\nInterrupted, cleaning up...'));
    }
    await close();
    process.exit(130); // Standard exit code for SIGINT
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const runMs = config.timeouts?.run_ms ?? DEFAULT_RUN_MS;
    // Golden paths resolve relative to the config file, not the cwd
    const golden = { baseDir: dirname(resolve(options.config)), update: options.updateGolden ?? false };
    const results = await withRunDeadline(
      runAllChecks(connection, config, verbose, golden),
      runMs,
      close
    );

    const report = buildReport(connection, results);
    await emitReport(report, { reporter, out: options.out, verbose });

    if (prContext) {
      await publishPrComment(report, prContext);
    }

    return getExitCode(results);
  } catch (err) {
    if (err instanceof RunDeadlineError) {
      // Incomplete run: nothing may claim pass or fail
      console.error(pc.red('Error:'), err.message);
      return 2;
    }
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await close();
  }
}
