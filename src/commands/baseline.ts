import pc from 'picocolors';
import type { Config } from '../config/schema.js';
import { connect } from '../client/connect.js';
import { captureSurface, saveLockfile } from '../surface/index.js';
import { redactString } from '../report/redact.js';
import { withRunDeadline, closeOnce } from './output.js';
import { DEFAULT_RUN_MS } from './run.js';

export interface BaselineOptions {
  config: string;
  verbose?: boolean;
}

/**
 * Captures the current server surface to a lockfile (baseline).
 * Returns exit code: 0 = success, 2 = error
 */
export async function baselineCommand(config: Config, _options: BaselineOptions): Promise<number> {
  const baselinePath = config.checks?.drift?.baseline ?? './mcpward.lock.json';

  console.log(pc.bold('Capturing baseline...'));
  console.log(
    pc.dim(
      `Server: ${redactString(config.server.transport === 'stdio' ? config.server.command : config.server.url)}`
    )
  );
  console.log(pc.dim(`Output: ${baselinePath}`));
  console.log();

  // Memoized close shared by the deadline and cleanup (see closeOnce)
  let close: (() => Promise<void>) | undefined;
  try {
    // Connect to server
    const connection = await connect(config);
    close = closeOnce(connection);
    console.log(
      pc.green('✓') +
        ` Connected to ${connection.serverInfo.name} v${connection.serverInfo.version}`
    );

    // Capture surface
    // Output sampling calls tools, so the whole-run deadline applies here too
    const conn = connection;
    const { surface, notes } = await withRunDeadline(
      captureSurface(conn, config),
      config.timeouts?.run_ms ?? DEFAULT_RUN_MS,
      close
    );
    const toolCount = Object.keys(surface.tools).length;
    console.log(pc.green('✓') + ` Captured ${toolCount} tool(s)`);
    if (config.checks?.drift?.output?.enabled) {
      const sampled = Object.values(surface.tools).filter((t) => t.outputShape).length;
      console.log(pc.green('✓') + ` Inferred output shape for ${sampled} tool(s)`);
      for (const note of notes) {
        const icon =
          note.status === 'failed' || note.status === 'partial' ? pc.yellow('⚠') : pc.dim('○');
        console.log(
          `  ${icon} ${pc.dim(`${note.tool}: ${note.status} — ${redactString(note.reason)}`)}`
        );
      }
    }

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
      if (tool.outputShape) annotations.push(`output: ${tool.outputShape.samples} sample(s)`);
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
    await close?.();
  }
}
