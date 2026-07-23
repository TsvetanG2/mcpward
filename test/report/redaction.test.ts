/**
 * Redaction tests
 *
 * Verifies that secrets interpolated from environment variables
 * do not appear in any reporter output.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/load.js';
import { connect } from '../../src/client/connect.js';
import { runComplianceChecks } from '../../src/checks/compliance.js';
import { runSchemaChecks } from '../../src/checks/schema.js';
import { runSecurityChecks } from '../../src/checks/security.js';
import {
  type CheckReport,
  summarizeResults,
} from '../../src/report/model.js';
import { renderJsonReport } from '../../src/report/json.js';
import { renderJunitReport } from '../../src/report/junit.js';
import { renderSarifReport } from '../../src/report/sarif.js';
import { renderConsoleReport } from '../../src/report/console.js';
import {
  redactReport,
  redactString,
  registerSecret,
  clearSecrets,
  getSecretCount,
} from '../../src/report/redact.js';

// Distinctive token value that should never appear in output
const TEST_SECRET = 'super_secret_token_xyz789_do_not_leak';

describe('Secret Redaction', () => {
  beforeEach(() => {
    clearSecrets();
  });

  describe('redactString', () => {
    it('redacts registered secrets', () => {
      registerSecret(TEST_SECRET);
      const input = `Authorization: Bearer ${TEST_SECRET}`;
      const output = redactString(input);
      expect(output).not.toContain(TEST_SECRET);
      expect(output).toContain('[REDACTED]');
    });

    it('redacts Bearer tokens', () => {
      const input = 'Authorization: Bearer abc123xyz';
      const output = redactString(input);
      expect(output).toContain('Bearer [REDACTED]');
      expect(output).not.toContain('abc123xyz');
    });

    it('redacts API keys in query strings', () => {
      const input = 'https://api.example.com?api_key=secret123&other=value';
      const output = redactString(input);
      expect(output).not.toContain('secret123');
      expect(output).toContain('api_key=[REDACTED]');
    });

    it('redacts basic auth in URLs', () => {
      const input = 'https://user:password123@example.com/path';
      const output = redactString(input);
      expect(output).not.toContain('password123');
      expect(output).toContain('[REDACTED]:[REDACTED]@');
    });

    it('handles empty strings', () => {
      expect(redactString('')).toBe('');
    });
  });

  describe('Config loading registers secrets', () => {
    it('registers interpolated environment variables', async () => {
      // Set environment variable
      process.env.TEST_TOKEN = TEST_SECRET;

      try {
        // Create a temporary config file
        const tempDir = join(tmpdir(), 'mcpward-test-' + Date.now());
        await mkdir(tempDir, { recursive: true });
        const configPath = join(tempDir, 'mcpward.yaml');

        await writeFile(
          configPath,
          `
server:
  transport: http
  url: https://example.com/mcp
  headers:
    Authorization: "Bearer \${TEST_TOKEN}"
`,
          'utf-8'
        );

        // Load config - this should register the secret
        try {
          await loadConfig(configPath);
        } catch {
          // Config might fail validation but secret should still be registered
        }

        // The secret should be registered
        expect(getSecretCount()).toBeGreaterThan(0);

        // Redaction should work
        const testString = `Error connecting to https://example.com with token ${TEST_SECRET}`;
        const redacted = redactString(testString);
        expect(redacted).not.toContain(TEST_SECRET);

        // Cleanup
        await unlink(configPath);
      } finally {
        delete process.env.TEST_TOKEN;
      }
    });
  });

  describe('Report redaction', () => {
    it('redacts secrets from all reporter outputs', async () => {
      // Register a secret
      registerSecret(TEST_SECRET);

      // Create a mock report with the secret in various places
      const report: CheckReport = {
        version: '0.1.0',
        timestamp: new Date().toISOString(),
        server: {
          name: 'test-server',
          version: '1.0.0',
          protocolVersion: '2025-11-25',
        },
        summary: {
          total: 2,
          passed: 1,
          failed: 1,
          warnings: 0,
          skipped: 0,
        },
        results: [
          {
            id: 'test/pass',
            family: 'compliance',
            status: 'pass',
            severity: 'info',
            message: 'Test passed',
          },
          {
            id: 'test/fail',
            family: 'compliance',
            status: 'fail',
            severity: 'error',
            message: `Connection failed with token ${TEST_SECRET}`,
            expected: 'Connection success',
            actual: `Failed: ${TEST_SECRET} was rejected`,
            location: `https://api.example.com?token=${TEST_SECRET}`,
          },
        ],
      };

      // Redact the report
      redactReport(report);

      // Verify the report itself is redacted
      const failResult = report.results.find((r) => r.id === 'test/fail');
      expect(failResult?.message).not.toContain(TEST_SECRET);
      expect(String(failResult?.actual)).not.toContain(TEST_SECRET);
      expect(failResult?.location).not.toContain(TEST_SECRET);

      // Render all reporters and check none contain the secret
      const jsonOutput = renderJsonReport(report);
      expect(jsonOutput).not.toContain(TEST_SECRET);

      const junitOutput = renderJunitReport(report);
      expect(junitOutput).not.toContain(TEST_SECRET);

      const sarifOutput = renderSarifReport(report);
      expect(sarifOutput).not.toContain(TEST_SECRET);

      // Console reporter writes to stdout, capture it
      const originalLog = console.log;
      let consoleOutput = '';
      console.log = (msg: string) => {
        consoleOutput += msg + '\n';
      };
      try {
        renderConsoleReport(report, { verbose: true });
      } finally {
        console.log = originalLog;
      }
      expect(consoleOutput).not.toContain(TEST_SECRET);
    });
  });

  describe('Integration with real server', () => {
    it('does not leak secrets in reports', async () => {
      // Set up secret
      process.env.MCPWARD_TEST_SECRET = TEST_SECRET;

      try {
        // Create config that uses the secret
        const tempDir = await mkdtemp(join(tmpdir(), 'mcpward-redact-test-'));
        const configPath = join(tempDir, 'mcpward.yaml');

        // Use stdio transport (which will succeed) but reference the secret
        await writeFile(
          configPath,
          `
server:
  transport: stdio
  command: npx
  args: ['tsx', './fixtures/good-server/index.ts']
  env:
    SOME_SECRET: "\${MCPWARD_TEST_SECRET}"
`,
          'utf-8'
        );

        // Load config (this registers the secret)
        const config = await loadConfig(configPath);

        // Connect and run checks
        const connection = await connect(config);

        try {
          const results = [
            ...(await runComplianceChecks({ connection, config })),
            ...(await runSchemaChecks({ connection })),
            ...(await runSecurityChecks({ connection })),
          ];

          const report: CheckReport = {
            version: '0.1.0',
            timestamp: new Date().toISOString(),
            server: {
              name: connection.serverInfo.name,
              version: connection.serverInfo.version,
              protocolVersion: connection.protocolVersion,
            },
            summary: summarizeResults(results),
            results,
          };

          // Redact
          redactReport(report);

          // Render all formats
          const jsonOutput = renderJsonReport(report);
          const junitOutput = renderJunitReport(report);
          const sarifOutput = renderSarifReport(report);

          // None should contain the secret
          expect(jsonOutput).not.toContain(TEST_SECRET);
          expect(junitOutput).not.toContain(TEST_SECRET);
          expect(sarifOutput).not.toContain(TEST_SECRET);
        } finally {
          await connection.close();
        }

        // Cleanup
        await unlink(configPath);
      } finally {
        delete process.env.MCPWARD_TEST_SECRET;
      }
    }, 30000);
  });
});
