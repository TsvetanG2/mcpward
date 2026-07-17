import { writeFile } from 'node:fs/promises';
import pc from 'picocolors';
import { connect } from '../client/connect.js';
import { runComplianceChecks } from '../checks/compliance.js';
import { runSchemaChecks } from '../checks/schema.js';
import {
  type CheckResult,
  type CheckReport,
  summarizeResults,
  getExitCode,
} from '../report/model.js';
import { renderConsoleReport } from '../report/console.js';
import { renderJsonReport } from '../report/json.js';
import type { Config } from '../config/schema.js';

const VERSION = '0.1.0';

export interface RunOptions {
  config: string;
  reporter: string;
  out?: string;
  json?: boolean;
  verbose?: boolean;
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

    // Build report
    const report: CheckReport = {
      version: VERSION,
      timestamp: new Date().toISOString(),
      server: {
        name: connection.serverInfo.name,
        version: connection.serverInfo.version,
        protocolVersion: connection.protocolVersion,
      },
      summary: summarizeResults(results),
      results,
    };

    // Output report
    if (reporter === 'json') {
      const json = renderJsonReport(report);
      if (options.out) {
        await writeFile(options.out, json, 'utf-8');
        console.log(pc.dim(`Report written to ${options.out}`));
      } else {
        console.log(json);
      }
    } else {
      // Console reporter
      renderConsoleReport(report, { verbose });
    }

    return getExitCode(results);
  } finally {
    await connection.close();
  }
}
