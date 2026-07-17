import pc from 'picocolors';
import { connect } from '../client/connect.js';
import type { Config } from '../config/schema.js';

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
    // Print server info
    console.log(pc.bold('Server:'), connection.serverInfo.name, pc.dim(`v${connection.serverInfo.version}`));
    console.log(pc.bold('Protocol:'), connection.protocolVersion);

    // List tools
    const toolsResult = await connection.client.listTools();
    const tools = toolsResult.tools;

    console.log('');
    console.log(pc.bold(`Tools (${tools.length}):`));
    for (const tool of tools) {
      console.log(`  ${pc.cyan(tool.name)}: ${pc.dim(tool.description ?? '(no description)')}`);
    }

    // List resources if available
    if (connection.capabilities.resources) {
      try {
        const resourcesResult = await connection.client.listResources();
        const resources = resourcesResult.resources;
        console.log('');
        console.log(pc.bold(`Resources (${resources.length}):`));
        for (const resource of resources) {
          console.log(`  ${pc.cyan(resource.uri)}: ${pc.dim(resource.name ?? '(no name)')}`);
        }
      } catch {
        // Resources not supported or failed
      }
    }

    // List prompts if available
    if (connection.capabilities.prompts) {
      try {
        const promptsResult = await connection.client.listPrompts();
        const prompts = promptsResult.prompts;
        console.log('');
        console.log(pc.bold(`Prompts (${prompts.length}):`));
        for (const prompt of prompts) {
          console.log(`  ${pc.cyan(prompt.name)}: ${pc.dim(prompt.description ?? '(no description)')}`);
        }
      } catch {
        // Prompts not supported or failed
      }
    }

    console.log('');
    console.log(pc.green('Connection successful!'));
    console.log(pc.dim('(Full check suite will be implemented in Phase 1)'));

    return 0;
  } finally {
    await connection.close();
  }
}
