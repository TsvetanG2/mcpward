#!/usr/bin/env node
/**
 * Integration baseline capture script.
 *
 * Runs mcpward against version-pinned reference MCP servers and captures
 * their non-pass findings as committed baselines. This is the ONLY way
 * baselines get created or updated — a human must run this deliberately,
 * review the diff, and commit.
 *
 * Usage:
 *   pnpm run build
 *   node scripts/integration-baseline.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { normalizeReport } from './integration-common.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Read package.json version
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const MCPWARD_VERSION = packageJson.version;

// Single source of truth: read server matrix from JSON
const servers = JSON.parse(readFileSync(join(ROOT, 'test/integration/servers.json'), 'utf-8'));

console.log('Integration Baseline Capture');
console.log('============================\n');
console.log(`mcpward version: ${MCPWARD_VERSION}\n`);

// Ensure baselines directory exists
mkdirSync(join(ROOT, 'test/integration/baselines'), { recursive: true });

// Prepare sandbox for filesystem server (Windows + Linux compatible)
const sandboxDir =
  process.platform === 'win32'
    ? join(ROOT, 'test', '.integration-sandbox')
    : mkdtempSync(join(tmpdir(), 'mcpward-sandbox-'));
mkdirSync(sandboxDir, { recursive: true });
// Overwrite, not 'wx': the Windows sandbox path is stable, so reruns must not crash
writeFileSync(join(sandboxDir, 'hello.txt'), 'hello\n');

for (const server of servers) {
  console.log(`Capturing baseline for ${server.name}...`);
  console.log(`  Package: ${server.pkg}`);

  // Replace /tmp/mcpward-sandbox with actual sandbox path
  // Escape backslashes for YAML
  const serverArgs = server.args.replace('/tmp/mcpward-sandbox', sandboxDir.replace(/\\/g, '\\\\'));

  // Generate config YAML
  const argsLine = serverArgs
    ? `args: ["-y", "${server.pkg}", "${serverArgs}"]`
    : `args: ["-y", "${server.pkg}"]`;

  const configYaml = `server:
  transport: stdio
  command: npx
  ${argsLine}
checks:
  compliance: true
  schema: true
  security: true
`;

  const configPath = join(ROOT, `integration-${server.name}.yaml`);
  const reportPath = join(ROOT, `integration-${server.name}.json`);

  writeFileSync(configPath, configYaml);

  try {
    // Run mcpward (may exit 1 due to findings — that's expected)
    execSync(
      `node dist/cli.js run --config "${configPath}" --reporter json --out "${reportPath}"`,
      {
        cwd: ROOT,
        stdio: 'inherit',
      }
    );
  } catch (err) {
    // Exit 1 from findings is expected, exit 2 is a real error
    if (err.status === 2) {
      console.error(`  ERROR: mcpward failed with exit code 2 (config/connection error)`);
      process.exit(1);
    }
    // Exit 1 is fine — findings are expected
  }

  // Read the JSON report
  const report = JSON.parse(readFileSync(reportPath, 'utf-8'));

  // Normalize to extract stable finding identities
  const findings = normalizeReport(report);

  // Build baseline object
  const baseline = {
    server: server.pkg,
    capturedWith: `mcpward@${MCPWARD_VERSION}`,
    note: 'Reference server violates parts of the MCP spec. See docs for details.',
    findings,
  };

  // Write baseline
  const baselinePath = join(ROOT, 'test/integration/baselines', `${server.name}.json`);
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');

  console.log(`  ✓ Captured ${findings.length} non-pass findings`);
  console.log(`  → ${baselinePath}\n`);

  // Clean up temp files
  try {
    execSync(`rm "${configPath}" "${reportPath}"`, { cwd: ROOT });
  } catch {
    // Ignore cleanup errors
  }
}

console.log('Done! Review the baselines and commit if they look correct.');
console.log('IMPORTANT: Never regenerate baselines blindly to silence CI.');
console.log('           A finding disappearing can mean mcpward stopped catching something.\n');
