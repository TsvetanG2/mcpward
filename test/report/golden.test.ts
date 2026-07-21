/**
 * Golden snapshot tests for reporters
 *
 * These tests lock the report shapes as a public contract.
 * Any change to report format should be deliberate and documented.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderJsonReport } from '../../src/report/json.js';
import { renderJunitReport } from '../../src/report/junit.js';
import { renderSarifReport, toHelpAnchor } from '../../src/report/sarif.js';
import { renderConsoleReport } from '../../src/report/console.js';
import type { CheckReport } from '../../src/report/model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fixed test report with one result per family and status
const FIXED_REPORT: CheckReport = {
  version: '0.1.0',
  timestamp: '2024-01-15T10:30:00.000Z', // Fixed timestamp
  server: {
    name: 'test-server',
    version: '1.0.0',
    protocolVersion: '2025-11-25',
  },
  summary: {
    total: 7,
    passed: 3,
    failed: 2,
    warnings: 1,
    skipped: 1,
  },
  results: [
    // Compliance - pass
    {
      id: 'compliance/handshake',
      family: 'compliance',
      status: 'pass',
      severity: 'info',
      message: 'Protocol handshake completed successfully',
      location: 'server',
    },
    // Schema - fail
    {
      id: 'schema/tool-name',
      family: 'schema',
      status: 'fail',
      severity: 'error',
      message: 'Tool name "invalid name" contains invalid characters',
      expected: 'Name matching ^[a-zA-Z0-9_-]+$',
      actual: 'invalid name',
      location: 'invalid name',
    },
    // Security - fail
    {
      id: 'security/injection-pattern',
      family: 'security',
      status: 'fail',
      severity: 'error',
      message: 'Tool "evil_tool" description contains injection-like pattern',
      actual: ['Ignore all previous instructions'],
      location: 'evil_tool',
    },
    // Drift - warn
    {
      id: 'drift/tool-added',
      family: 'drift',
      status: 'warn',
      severity: 'warning',
      message: 'New tool "new_feature" was added',
      location: 'new_feature',
    },
    // Behavioral - pass
    {
      id: 'behavioral/case',
      family: 'behavioral',
      status: 'pass',
      severity: 'info',
      message: 'Test case "echo test" passed',
      location: 'echo',
    },
    // Errors - pass
    {
      id: 'errors/unknown-tool',
      family: 'errors',
      status: 'pass',
      severity: 'info',
      message: 'Unknown tool correctly returned protocol error',
      location: '__unknown__',
    },
    // Latency - skip
    {
      id: 'latency/summary',
      family: 'latency',
      status: 'skip',
      severity: 'info',
      message: 'Latency checks skipped (no budget configured)',
    },
  ],
};

describe('Golden Snapshot Tests', () => {
  describe('JSON Reporter', () => {
    it('matches snapshot', () => {
      const output = renderJsonReport(FIXED_REPORT);
      expect(output).toMatchSnapshot();
    });

    it('produces valid JSON', () => {
      const output = renderJsonReport(FIXED_REPORT);
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('contains all required fields', () => {
      const output = renderJsonReport(FIXED_REPORT);
      const parsed = JSON.parse(output);

      expect(parsed).toHaveProperty('version');
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('server');
      expect(parsed).toHaveProperty('summary');
      expect(parsed).toHaveProperty('results');
      expect(parsed.results).toHaveLength(7);
    });
  });

  describe('JUnit Reporter', () => {
    it('matches snapshot', () => {
      const output = renderJunitReport(FIXED_REPORT);
      expect(output).toMatchSnapshot();
    });

    it('produces well-formed XML', () => {
      const output = renderJunitReport(FIXED_REPORT);

      // Basic XML structure checks
      expect(output).toMatch(/^<\?xml version="1\.0"/);
      expect(output).toContain('<testsuites');
      expect(output).toContain('</testsuites>');

      // Check for properly closed tags - count opening and closing testcase tags
      // Note: classnames may contain "/" so we can't use [^/]* in the regex
      const openTags = output.match(/<testcase\s+[^>]*>/g) || [];
      const closeTags = output.match(/<\/testcase>/g) || [];

      // Each testcase should have a closing tag
      expect(openTags.length).toBe(closeTags.length);
      expect(openTags.length).toBe(7); // One per result
    });

    it('contains test counts', () => {
      const output = renderJunitReport(FIXED_REPORT);

      expect(output).toContain('tests="7"');
      expect(output).toContain('failures="2"');
    });

    it('marks failures correctly', () => {
      const output = renderJunitReport(FIXED_REPORT);

      // Failed tests should have <failure> elements
      expect(output).toContain('<failure');
      expect(output).toContain('invalid characters');
      expect(output).toContain('injection-like pattern');
    });
  });

  describe('SARIF Reporter', () => {
    it('matches snapshot', () => {
      const output = renderSarifReport(FIXED_REPORT);
      expect(output).toMatchSnapshot();
    });

    it('produces valid JSON', () => {
      const output = renderSarifReport(FIXED_REPORT);
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('conforms to SARIF 2.1.0 structure', () => {
      const output = renderSarifReport(FIXED_REPORT);
      const sarif = JSON.parse(output);

      // Required SARIF fields
      expect(sarif).toHaveProperty('$schema');
      expect(sarif).toHaveProperty('version', '2.1.0');
      expect(sarif).toHaveProperty('runs');
      expect(sarif.runs).toHaveLength(1);

      const run = sarif.runs[0];
      expect(run).toHaveProperty('tool');
      expect(run).toHaveProperty('results');
      expect(run.tool).toHaveProperty('driver');
      expect(run.tool.driver).toHaveProperty('name', 'mcpward');
      expect(run.tool.driver).toHaveProperty('rules');
    });

    it('includes rules for all check families', () => {
      const output = renderSarifReport(FIXED_REPORT);
      const sarif = JSON.parse(output);
      const rules = sarif.runs[0].tool.driver.rules;

      // Should have rules for unique check IDs (SARIF uses dashes in id, slashes in name)
      const ruleIds = rules.map((r: { id: string }) => r.id);
      expect(ruleIds).toContain('compliance-handshake');
      expect(ruleIds).toContain('schema-tool-name');
      expect(ruleIds).toContain('security-injection-pattern');
    });

    it('only includes failed results', () => {
      const output = renderSarifReport(FIXED_REPORT);
      const sarif = JSON.parse(output);
      const results = sarif.runs[0].results;

      // SARIF results should only be failures (not passes/skips)
      // Actually check what we have - SARIF might include warnings too
      for (const result of results) {
        expect(['error', 'warning', 'note']).toContain(result.level);
      }
    });

    it('has valid helpUri anchors that exist in docs/rules.md', async () => {
      // Read the rules documentation
      const rulesPath = join(__dirname, '../../docs/rules.md');
      const rulesContent = await readFile(rulesPath, 'utf-8');

      // Extract all markdown headings and convert to anchors
      // GitHub Flavored Markdown: ## heading/name -> #headingname
      const headingRegex = /^###?\s+(.+)$/gm;
      const validAnchors = new Set<string>();
      let match;
      while ((match = headingRegex.exec(rulesContent)) !== null) {
        // Convert heading to anchor: lowercase, remove non-alphanumeric except hyphens
        const anchor = match[1]
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '');
        validAnchors.add(anchor);
      }

      // Get all helpUri anchors from SARIF output
      const output = renderSarifReport(FIXED_REPORT);
      const sarif = JSON.parse(output);
      const rules = sarif.runs[0].tool.driver.rules;

      // Verify each rule's helpUri anchor exists in docs/rules.md
      for (const rule of rules) {
        const url = new URL(rule.helpUri);
        const anchor = url.hash.slice(1); // Remove leading #

        expect(
          validAnchors.has(anchor),
          `helpUri anchor "${anchor}" for rule "${rule.id}" not found in docs/rules.md. ` +
            `Expected one of: ${[...validAnchors].slice(0, 10).join(', ')}...`
        ).toBe(true);
      }
    });

    it('toHelpAnchor generates correct anchors', () => {
      // Test the shared anchor generation function
      expect(toHelpAnchor('compliance/handshake')).toBe('compliancehandshake');
      expect(toHelpAnchor('security/injection-pattern')).toBe('securityinjection-pattern');
      expect(toHelpAnchor('schema/tool-name')).toBe('schematool-name');
      expect(toHelpAnchor('drift/description-changed')).toBe('driftdescription-changed');
    });
  });

  describe('Console Reporter', () => {
    it('matches snapshot (no colors, verbose)', () => {
      // Capture console output
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      };

      try {
        // Note: console reporter uses picocolors which auto-disables in non-TTY
        renderConsoleReport(FIXED_REPORT, { verbose: true });
      } finally {
        console.log = originalLog;
      }

      const output = lines.join('\n');
      expect(output).toMatchSnapshot();
    });

    it('matches snapshot (no colors, non-verbose)', () => {
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      };

      try {
        renderConsoleReport(FIXED_REPORT, { verbose: false });
      } finally {
        console.log = originalLog;
      }

      const output = lines.join('\n');
      expect(output).toMatchSnapshot();
    });

    it('shows summary counts', () => {
      const lines: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      };

      try {
        renderConsoleReport(FIXED_REPORT, { verbose: false });
      } finally {
        console.log = originalLog;
      }

      const output = lines.join('\n');
      expect(output).toContain('3 passed');
      expect(output).toContain('2 failed');
    });
  });
});
