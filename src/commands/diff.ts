import pc from 'picocolors';
import type { Config } from '../config/schema.js';

export interface DiffOptions {
  config: string;
  verbose?: boolean;
}

export async function diffCommand(
  _config: Config,
  _options: DiffOptions
): Promise<number> {
  console.log(pc.yellow('Diff command will be implemented in Phase 2'));
  console.log(pc.dim('This command will compare current server surface against the baseline.'));
  return 0;
}
