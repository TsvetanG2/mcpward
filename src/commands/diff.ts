import pc from 'picocolors';
import type { Config } from '../config/schema.js';
import { connect } from '../client/connect.js';
import { runDriftChecks } from '../checks/drift.js';
import { renderConsoleReport } from '../report/console.js';
import { summarizeResults, getExitCode, type CheckReport } from '../report/model.js';
import { redactReport, redactString } from '../report/redact.js';
import { MCPWARD_VERSION } from '../version.js';

export interface DiffOptions {
  config: string;
  verbose?: boolean;
  json?: boolean;
}

/**
 * Compares current server surface against baseline and reports drift.
 * Returns exit code: 0 = no failing drift, 1 = drift detected, 2 = error
 */
export async function diffCommand(
  config: Config,
  options: DiffOptions
): Promise<number> {
  const baselinePath = config.checks?.drift?.baseline ?? './mcpward.lock.json';

  if (!options.json) {
    console.log(pc.bold('Checking for drift...'));
    console.log(pc.dim(`Server: ${redactString(config.server.transport === 'stdio' ? config.server.command : config.server.url)}`));
    console.log(pc.dim(`Baseline: ${baselinePath}`));
    console.log();
  }

  let connection;
  try {
    // Connect to server
    connection = await connect(config);

    // Run drift checks
    const driftConfig = config.checks?.drift;
    const results = await runDriftChecks({
      connection,
      fullConfig: config,
      config: driftConfig,
    });

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

    // Redact before ANY output — the --json path must not bypass it
    redactReport(report);

    if (options.json) {
      console.log(JSON.stringify(report.results, null, 2));
    } else {
      renderConsoleReport(report, { verbose: options.verbose ?? false });
    }

    return getExitCode(results);
  } catch (err) {
    console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
    return 2;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}
