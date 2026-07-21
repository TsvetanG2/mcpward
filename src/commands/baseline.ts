import pc from 'picocolors';
import type { Config } from '../config/schema.js';
import { connect } from '../client/connect.js';
import { captureServerSurface, saveLockfile } from '../surface/index.js';

export interface BaselineOptions {
  config: string;
  verbose?: boolean;
}

/**
 * Captures the current server surface to a lockfile (baseline).
 * Returns exit code: 0 = success, 2 = error
 */
export async function baselineCommand(
  config: Config,
  _options: BaselineOptions
): Promise<number> {
  const baselinePath = config.checks?.drift?.baseline ?? './mcpward.lock.json';

  console.log(pc.bold('Capturing baseline...'));
  console.log(pc.dim(`Server: ${config.server.transport === 'stdio' ? config.server.command : config.server.url}`));
  console.log(pc.dim(`Output: ${baselinePath}`));
  console.log();

  let connection;
  try {
    // Connect to server
    connection = await connect(config);
    console.log(pc.green('✓') + ` Connected to ${connection.serverInfo.name} v${connection.serverInfo.version}`);

    // Capture surface
    const surface = await captureServerSurface(connection);
    const toolCount = Object.keys(surface.tools).length;
    console.log(pc.green('✓') + ` Captured ${toolCount} tool(s)`);

    // Save lockfile
    await saveLockfile(surface, baselinePath);
    console.log(pc.green('✓') + ` Baseline saved to ${baselinePath}`);
    console.log();

    // Print tool summary
    console.log(pc.bold('Tools captured:'));
    for (const toolName of Object.keys(surface.tools).sort()) {
      const tool = surface.tools[toolName];
      if (!tool) continue;
      const annotations = [];
      if (tool.annotations?.readOnlyHint) annotations.push('readOnly');
      if (tool.annotations?.destructiveHint) annotations.push('destructive');
      const annotStr = annotations.length > 0 ? pc.dim(` [${annotations.join(', ')}]`) : '';
      console.log(`  ${pc.cyan('•')} ${toolName}${annotStr}`);
    }

    console.log();
    console.log(pc.green('Baseline captured successfully.'));
    console.log(pc.dim('Run "mcpward diff" to check for drift against this baseline.'));

    return 0;
  } catch (err) {
    console.error(pc.red('Error:'), err instanceof Error ? err.message : String(err));
    return 2;
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}
