/**
 * Error contract check tests
 *
 * Tests the two-layer error contract:
 * 1. Protocol errors (JSON-RPC error): unknown tool, malformed call, invalid params
 * 2. Tool errors (isError: true): tool execution failures
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { connect } from '../../src/client/connect.js';
import { runErrorContractChecks } from '../../src/checks/errors.js';
import type { Config } from '../../src/config/schema.js';

// Fixture paths
const FIXTURES_DIR = join(process.cwd(), 'fixtures');
const GOOD_SERVER = join(FIXTURES_DIR, 'good-server', 'index.ts');
const ERROR_CONTRACT_SERVER = join(FIXTURES_DIR, 'error-contract-server', 'index.ts');

// Config for good server
const goodServerConfig: Config = {
  server: {
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', GOOD_SERVER],
    env: {},
  },
  checks: {},
  suites: [],
};

// Config for error-contract-server
const errorContractServerConfig: Config = {
  server: {
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', ERROR_CONTRACT_SERVER],
    env: {},
  },
  checks: {},
  suites: [],
};

describe('Error Contract Checks', () => {
  describe('against good-server', () => {
    it('passes unknown tool check (returns protocol error)', async () => {
      const connection = await connect(goodServerConfig);
      try {
        const results = await runErrorContractChecks({ connection });

        const unknownToolResult = results.find(
          (r) => r.id === 'errors/unknown-tool'
        );
        expect(unknownToolResult).toBeDefined();
        expect(unknownToolResult?.status).toBe('pass');
        expect(unknownToolResult?.message).toContain('protocol error');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('passes invalid params check for tools with required params', async () => {
      const connection = await connect(goodServerConfig);
      try {
        const results = await runErrorContractChecks({ connection });

        // good-server has 'echo' with required 'message' param
        const invalidParamsResults = results.filter(
          (r) => r.id === 'errors/invalid-params'
        );

        // Should have at least one check for tools with required params
        expect(invalidParamsResults.length).toBeGreaterThan(0);

        // Check that results are pass or warn (warn is acceptable if tool handles gracefully)
        for (const result of invalidParamsResults) {
          expect(['pass', 'warn']).toContain(result.status);
        }
      } finally {
        await connection.close();
      }
    }, 30000);

    it('summary passes for compliant server', async () => {
      const connection = await connect(goodServerConfig);
      try {
        const results = await runErrorContractChecks({ connection });

        const summary = results.find((r) => r.id === 'errors/summary');
        expect(summary).toBeDefined();
        // Summary should pass if no hard failures
        const failures = results.filter((r) => r.status === 'fail');
        if (failures.length === 0) {
          expect(summary?.status).toBe('pass');
        }
      } finally {
        await connection.close();
      }
    }, 30000);
  });

  describe('against error-contract-server', () => {
    it('still passes unknown tool check (server handles correctly)', async () => {
      const connection = await connect(errorContractServerConfig);
      try {
        const results = await runErrorContractChecks({ connection });

        const unknownToolResult = results.find(
          (r) => r.id === 'errors/unknown-tool'
        );
        expect(unknownToolResult).toBeDefined();
        // The error-contract-server correctly returns protocol error for unknown tools
        expect(unknownToolResult?.status).toBe('pass');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('checks invalid params for tools with required params', async () => {
      const connection = await connect(errorContractServerConfig);
      try {
        const results = await runErrorContractChecks({ connection });

        const invalidParamsResults = results.filter(
          (r) => r.id === 'errors/invalid-params'
        );

        // error-contract-server has 'read_file' with required 'path' param
        expect(invalidParamsResults.length).toBeGreaterThan(0);
      } finally {
        await connection.close();
      }
    }, 30000);
  });
});
