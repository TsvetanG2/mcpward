/**
 * Version consistency tests.
 *
 * CRITICAL: Ensures all code paths use the same version from package.json.
 * M1.2 found 5 hardcoded '0.1.0' strings that diverged from package.json.
 * This test prevents that regression.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MCPWARD_VERSION } from '../src/version.js';

// Read package.json version as ground truth
const packageJsonPath = join(process.cwd(), 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
  version: string;
};
const EXPECTED_VERSION = packageJson.version;

describe('Version consistency', () => {
  test('MCPWARD_VERSION matches package.json', () => {
    expect(MCPWARD_VERSION).toBe(EXPECTED_VERSION);
  });

  test('All source files use MCPWARD_VERSION from version.ts (no hardcoded versions)', () => {
    // This test verifies by checking that the shared module is imported.
    // Static analysis would be ideal, but we can verify the runtime behavior:
    // If any file uses a hardcoded version, it will diverge from package.json
    // and fail integration tests.

    // The real verification is that MCPWARD_VERSION is the single source of truth.
    // All files should import from ../version.js

    // Read source files and verify they import from version.ts
    const filesToCheck = [
      'src/cli.ts',
      'src/client/connect.ts',
      'src/commands/output.ts',
      'src/surface/capture.ts',
    ];

    for (const file of filesToCheck) {
      const filePath = join(process.cwd(), file);
      const content = readFileSync(filePath, 'utf-8');

      // Verify file imports MCPWARD_VERSION from version.ts
      // (path varies: './version.js' for cli.ts, '../version.js' for others)
      const hasVersionImport =
        content.includes("from './version.js'") ||
        content.includes("from '../version.js'");
      expect(hasVersionImport).toBe(true);
      expect(content).toContain('MCPWARD_VERSION');

      // Verify NO hardcoded version strings (except in comments)
      // This is a heuristic - look for version: '0.x.x' or .version('0.x.x')
      const lines = content.split('\n');
      for (const line of lines) {
        // Skip comments
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) {
          continue;
        }

        // Check for hardcoded version patterns
        const hardcodedVersionPattern = /(version:\s*['"]0\.\d+\.\d+['"]|\.version\(['"]0\.\d+\.\d+['"]\))/;
        if (hardcodedVersionPattern.test(line)) {
          throw new Error(
            `Found hardcoded version in ${file}:\n${line.trim()}\n` +
              `Use MCPWARD_VERSION from src/version.ts instead.`
          );
        }
      }
    }
  });

  test('Lockfile metadata uses MCPWARD_VERSION', async () => {
    // This verifies that captureServerSurface uses MCPWARD_VERSION
    // by checking the version.ts module is imported in capture.ts
    const capturePath = join(process.cwd(), 'src/surface/capture.ts');
    const captureContent = readFileSync(capturePath, 'utf-8');

    expect(captureContent).toContain("from '../version.js'");
    expect(captureContent).toContain('MCPWARD_VERSION');
  });

  test('CLI --version command uses MCPWARD_VERSION', () => {
    // Verify cli.ts imports and uses MCPWARD_VERSION
    const cliPath = join(process.cwd(), 'src/cli.ts');
    const cliContent = readFileSync(cliPath, 'utf-8');

    expect(cliContent).toContain("from './version.js'");
    expect(cliContent).toContain('MCPWARD_VERSION');
    expect(cliContent).toContain('.version(MCPWARD_VERSION)');
  });

  test('MCP client handshake uses MCPWARD_VERSION', () => {
    // Verify connect.ts imports and uses MCPWARD_VERSION
    const connectPath = join(process.cwd(), 'src/client/connect.ts');
    const connectContent = readFileSync(connectPath, 'utf-8');

    expect(connectContent).toContain("from '../version.js'");
    expect(connectContent).toContain('MCPWARD_VERSION');

    // A single shared Client constructor serves both transports (connectTransport)
    const clientConstructorPattern = /new Client\(\s*\{[^}]*version:\s*MCPWARD_VERSION/s;
    const matches = connectContent.match(new RegExp(clientConstructorPattern, 'g'));
    expect(matches).toHaveLength(1);
    expect(connectContent.match(/new Client\(/g)).toHaveLength(1);

    // ...and both stdio and HTTP go through it
    expect(connectContent.match(/return connectTransport\(transport, timeouts\)/g)).toHaveLength(2);
  });

  test('Report model uses MCPWARD_VERSION', () => {
    // The report is assembled in one place (output.ts) and both commands go through it
    const outputContent = readFileSync(join(process.cwd(), 'src/commands/output.ts'), 'utf-8');
    expect(outputContent).toContain("from '../version.js'");
    expect(outputContent).toContain('version: MCPWARD_VERSION');

    for (const command of ['src/commands/run.ts', 'src/commands/diff.ts']) {
      const content = readFileSync(join(process.cwd(), command), 'utf-8');
      expect(content).toContain('buildReport(');
      expect(content).not.toMatch(/version:\s*['"]\d/);
    }
  });
});
