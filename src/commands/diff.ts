import pc from 'picocolors';
import type { Config } from '../config/schema.js';
import { connect, type McpConnection } from '../client/connect.js';
import { runDriftChecks } from '../checks/drift.js';
import { getExitCode } from '../report/model.js';
import { detectPrContext } from '../report/github.js';
import { redactString } from '../report/redact.js';
import {
  buildReport,
  emitReport,
  publishPrComment,
  withRunDeadline,
  closeOnce,
} from './output.js';
import { DEFAULT_RUN_MS } from './run.js';

export interface DiffOptions {
  config: string;
  reporter?: string;
  out?: string;
  verbose?: boolean;
  json?: boolean;
  prComment?: boolean;
}

/**
 * Compares current server surface against baseline and reports drift.
 * Same reporters, PR comment and run deadline as `run` (shared output path).
 * Returns exit code: 0 = no failing drift, 1 = drift detected, 2 = error
 */
export async function diffCommand(config: Config, options: DiffOptions): Promise<number> {
  const reporter = options.json ? 'json' : (options.reporter ?? 'console');
  const prContext = options.prComment ? detectPrContext() : undefined;
  const baselinePath = config.checks?.drift?.baseline ?? './mcpward.lock.json';

  // Headers only for the human console view — machine-readable stdout must stay parseable
  if (reporter === 'console') {
    console.log(pc.bold('Checking for drift...'));
    console.log(
      pc.dim(
        `Server: ${redactString(config.server.transport === 'stdio' ? config.server.command : config.server.url)}`
      )
    );
    console.log(pc.dim(`Baseline: ${baselinePath}`));
    console.log();
  }

  // One memoized close shared by the deadline and cleanup, so cleanup waits for the server
  // to actually exit instead of returning early on a second close call
  let close: (() => Promise<void>) | undefined;
  try {
    const conn: McpConnection = await connect(config);
    close = closeOnce(conn);

    const results = await withRunDeadline(
      runDriftChecks({ connection: conn, fullConfig: config, config: config.checks?.drift }),
      config.timeouts?.run_ms ?? DEFAULT_RUN_MS,
      close
    );

    const report = buildReport(conn, results);
    await emitReport(report, { reporter, out: options.out, verbose: options.verbose });
    if (prContext) {
      await publishPrComment(report, prContext);
    }

    return getExitCode(results);
  } catch (err) {
    // Connection failure or run deadline (RunDeadlineError): nothing was fully tested
    console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
    return 2;
  } finally {
    await close?.().catch(() => undefined); // close errors do not change the diff result
  }
}
