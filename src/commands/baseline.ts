import pc from 'picocolors';
import type { Config } from '../config/schema.js';

export interface BaselineOptions {
  config: string;
  verbose?: boolean;
}

export async function baselineCommand(
  _config: Config,
  _options: BaselineOptions
): Promise<void> {
  console.log(pc.yellow('Baseline command will be implemented in Phase 2'));
  console.log(pc.dim('This command will capture the server surface to a lockfile.'));
}
