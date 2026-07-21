/**
 * Integration tests for checks
 *
 * Tests run against fixture servers to verify:
 * 1. good-server passes ALL checks (zero false positives)
 * 2. malformed-server fails specific checks (negative tests)
 */

import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runComplianceChecks } from '../../src/checks/compliance.js';
import { runSchemaChecks } from '../../src/checks/schema.js';
import type { Config } from '../../src/config/schema.js';

// Helper to create a test connection
async function createTestConnection(serverPath: string) {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
  });

  const client = new Client(
    { name: 'mcpward-test', version: '0.1.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

  const serverInfo = client.getServerVersion();
  const capabilities = client.getServerCapabilities();

  const timeouts = { connect_ms: 10000, call_ms: 30000, run_ms: 300000 };
  return {
    client,
    protocolVersion: '2025-11-25',
    serverInfo: {
      name: serverInfo?.name ?? 'unknown',
      version: serverInfo?.version ?? '0.0.0',
    },
    capabilities: capabilities ?? {},
    timeouts,
    close: async () => {
      await client.close();
    },
    callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => {
      return client.callTool(params);
    },
  };
}

describe('Compliance Checks', () => {
  describe('against good-server', () => {
    it('all checks pass', async () => {
      const connection = await createTestConnection('fixtures/good-server/index.ts');

      try {
        const config: Config = {
          server: { transport: 'stdio', command: 'npx', args: [] },
          suites: [],
        };

        const results = await runComplianceChecks({ connection, config });

        // All should pass
        const failures = results.filter((r) => r.status === 'fail');
        expect(failures).toHaveLength(0);

        // Should have expected checks
        expect(results.some((r) => r.id === 'compliance/handshake')).toBe(true);
        expect(results.some((r) => r.id === 'compliance/protocol-version')).toBe(true);
        expect(results.some((r) => r.id === 'compliance/server-info')).toBe(true);
        expect(results.some((r) => r.id === 'compliance/capabilities')).toBe(true);
        expect(results.some((r) => r.id === 'compliance/ping')).toBe(true);
      } finally {
        await connection.close();
      }
    }, 30000);
  });
});

describe('Schema Checks', () => {
  describe('against good-server (zero false positives)', () => {
    it('all checks pass', async () => {
      const connection = await createTestConnection('fixtures/good-server/index.ts');

      try {
        const results = await runSchemaChecks({ connection });

        // All should pass
        const failures = results.filter((r) => r.status === 'fail');
        expect(failures).toHaveLength(0);
      } finally {
        await connection.close();
      }
    }, 30000);
  });

  describe('against malformed-server (negative tests)', () => {
    it('detects empty description', async () => {
      const connection = await createTestConnection('fixtures/malformed-server/index.ts');

      try {
        const results = await runSchemaChecks({ connection });

        const emptyDescFailure = results.find(
          (r) =>
            r.status === 'fail' &&
            r.id === 'schema/tool-description' &&
            r.location === 'empty_description'
        );

        expect(emptyDescFailure).toBeDefined();
        expect(emptyDescFailure?.message).toContain('empty description');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('detects invalid tool names (spaces)', async () => {
      const connection = await createTestConnection('fixtures/malformed-server/index.ts');

      try {
        const results = await runSchemaChecks({ connection });

        const invalidNameFailure = results.find(
          (r) =>
            r.status === 'fail' &&
            r.id === 'schema/tool-name' &&
            r.location === 'invalid name with spaces'
        );

        expect(invalidNameFailure).toBeDefined();
        expect(invalidNameFailure?.message).toContain('invalid characters');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('detects invalid tool names (special chars)', async () => {
      const connection = await createTestConnection('fixtures/malformed-server/index.ts');

      try {
        const results = await runSchemaChecks({ connection });

        const invalidNameFailure = results.find(
          (r) =>
            r.status === 'fail' &&
            r.id === 'schema/tool-name' &&
            r.location === 'invalid@name!'
        );

        expect(invalidNameFailure).toBeDefined();
        expect(invalidNameFailure?.message).toContain('invalid characters');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('detects missing description', async () => {
      const connection = await createTestConnection('fixtures/malformed-server/index.ts');

      try {
        const results = await runSchemaChecks({ connection });

        const noDescFailure = results.find(
          (r) =>
            r.status === 'fail' &&
            r.id === 'schema/tool-description' &&
            r.location === 'no_description'
        );

        expect(noDescFailure).toBeDefined();
        expect(noDescFailure?.message).toContain('no description');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('detects invalid inputSchema (bad type)', async () => {
      const connection = await createTestConnection('fixtures/malformed-server/index.ts');

      try {
        const results = await runSchemaChecks({ connection });

        const badSchemaFailure = results.find(
          (r) =>
            r.status === 'fail' &&
            r.id === 'schema/tool-input-schema' &&
            r.location === 'bad_schema'
        );

        expect(badSchemaFailure).toBeDefined();
        expect(badSchemaFailure?.message).toContain('invalid inputSchema');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('detects duplicate tool names', async () => {
      const connection = await createTestConnection('fixtures/malformed-server/index.ts');

      try {
        const results = await runSchemaChecks({ connection });

        const duplicateFailure = results.find(
          (r) =>
            r.status === 'fail' &&
            r.id === 'schema/unique-names'
        );

        expect(duplicateFailure).toBeDefined();
        expect(duplicateFailure?.message).toContain('valid_tool');
      } finally {
        await connection.close();
      }
    }, 30000);

    // NOTE: Invalid annotation types cannot be tested via live server because
    // the MCP SDK validates annotations with Zod before returning results.
    // Test annotation validation with unit tests instead.
  });
});

describe('Exit Codes', () => {
  it('returns 0 when all checks pass', async () => {
    const connection = await createTestConnection('fixtures/good-server/index.ts');

    try {
      const config: Config = {
        server: { transport: 'stdio', command: 'npx', args: [] },
        suites: [],
      };

      const complianceResults = await runComplianceChecks({ connection, config });
      const schemaResults = await runSchemaChecks({ connection });
      const allResults = [...complianceResults, ...schemaResults];

      const hasFailed = allResults.some((r) => r.status === 'fail');
      expect(hasFailed).toBe(false);
    } finally {
      await connection.close();
    }
  }, 30000);

  it('returns 1 when checks fail', async () => {
    const connection = await createTestConnection('fixtures/malformed-server/index.ts');

    try {
      const schemaResults = await runSchemaChecks({ connection });

      const hasFailed = schemaResults.some((r) => r.status === 'fail');
      expect(hasFailed).toBe(true);
    } finally {
      await connection.close();
    }
  }, 30000);
});
