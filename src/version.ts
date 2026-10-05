/**
 * mcpward version — read from package.json at module load time.
 *
 * CRITICAL: This is the single source of truth for the mcpward version.
 * Used by:
 * - CLI (mcpward --version)
 * - MCP client handshake (clientInfo.version)
 * - Report headers (JSON, JUnit, SARIF, console)
 * - Lockfile metadata (meta.mcpwardVersion)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '../package.json');

const packageJson = JSON.parse(
  readFileSync(packageJsonPath, 'utf-8')
) as { version: string };

/**
 * mcpward version from package.json.
 * Example: "0.8.0"
 */
export const MCPWARD_VERSION = packageJson.version;
