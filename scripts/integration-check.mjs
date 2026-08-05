#!/usr/bin/env node
/**
 * Integration baseline comparison script.
 *
 * Given a server name and a fresh JSON report, compares actual findings
 * against the committed baseline. Exits 0 if they match, exits 1 with
 * a delta report if they differ.
 *
 * This is the gate in CI — the workflow runs mcpward (which may exit 1
 * due to findings), then runs THIS script. This script's exit code is
 * what determines job success/failure.
 *
 * Usage:
 *   node scripts/integration-check.mjs <server-name> <report-path>
 *
 * Example:
 *   node scripts/integration-check.mjs memory result-memory.json
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { normalizeReport, compareFindings } from './integration-common.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Parse arguments
const [, , serverName, reportPath] = process.argv;

if (!serverName || !reportPath) {
  console.error('Usage: node integration-check.mjs <server-name> <report-path>');
  console.error('Example: node integration-check.mjs memory result-memory.json');
  process.exit(2);
}

// Load baseline
const baselinePath = join(
  ROOT,
  'test/integration/baselines',
  `${serverName}.json`
);

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
} catch (err) {
  console.error(`ERROR: Could not read baseline for ${serverName}`);
  console.error(`  Expected: ${baselinePath}`);
  console.error(`  ${err.message}`);
  process.exit(2);
}

// Load actual report
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf-8'));
} catch (err) {
  console.error(`ERROR: Could not read report`);
  console.error(`  Path: ${reportPath}`);
  console.error(`  ${err.message}`);
  process.exit(2);
}

// Normalize actual report
const actualFindings = normalizeReport(report);

// Compare
const { added, missing, match } = compareFindings(
  actualFindings,
  baseline.findings
);

// Exit 0 if match (silent on green)
if (match) {
  console.log(`✓ ${serverName}: actual findings match baseline`);
  process.exit(0);
}

// Exit 1 with delta report if mismatch
console.log(`✗ ${serverName}: findings differ from baseline\n`);

if (added.length > 0) {
  console.log(`NEW FINDINGS (${added.length}):`);
  console.log('  These appeared in the actual run but are NOT in the baseline.');
  console.log('  This could be:');
  console.log('    - A regression in the reference server');
  console.log('    - A new check in mcpward detecting a real violation');
  console.log('    - A bug in mcpward (false positive)\n');
  for (const finding of added) {
    console.log(
      `  + ${finding.family}/${finding.id} [${finding.status}] at ${finding.location ?? 'none'}`
    );
  }
  console.log();
}

if (missing.length > 0) {
  console.log(`MISSING FINDINGS (${missing.length}):`);
  console.log('  These are in the baseline but DID NOT appear in the actual run.');
  console.log('  This could be:');
  console.log('    - The reference server was fixed');
  console.log('    - mcpward stopped detecting something (FALSE NEGATIVE — serious!)');
  console.log('    - A check was disabled or removed\n');
  for (const finding of missing) {
    console.log(
      `  - ${finding.family}/${finding.id} [${finding.status}] at ${finding.location ?? 'none'}`
    );
  }
  console.log();
}

console.log('IMPORTANT: Review the delta carefully before updating the baseline.');
console.log('           A missing finding can mean mcpward stopped catching something.');
console.log(`           If this delta is expected, regenerate with: pnpm run integration:baseline\n`);

process.exit(1);
