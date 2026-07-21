import pc from 'picocolors';
import type { Config } from '../config/schema.js';
import { connect } from '../client/connect.js';
import { runDriftChecks } from '../checks/drift.js';
import { renderConsoleReport } from '../report/console.js';
import { summarizeResults, getExitCode, type CheckReport } from '../report/model.js';

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
    console.log(pc.dim(`Server: ${config.server.transport === 'stdio' ? config.server.command : config.server.url}`));
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
      config: driftConfig,
    });

    // Report results
    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      // Build report for console output
      const report: CheckReport = {
        version: '0.1.0',
        timestamp: new Date().toISOString(),
        server: {
          name: connection.serverInfo.name,
          version: connection.serverInfo.version,
          protocolVersion: connection.protocolVersion,
        },
        summary: summarizeResults(results),
        results,
      };
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
