/**
 * Compliance check tests
 *
 * Tests protocol compliance checks including negative cases
 * where the server returns invalid data.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runComplianceChecks } from '../../src/checks/compliance.js';
import { connect, type McpConnection } from '../../src/client/connect.js';
import type { Config, ConfigInput } from '../../src/config/schema.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { testConfig } from '../helpers/config.js';

/**
 * Creates a mock connection for testing compliance checks.
 *
 * Deliberately allows INVALID server data (e.g. serverInfo without a version, null
 * capabilities) — that is what these negative tests feed the checks — so the result is
 * cast rather than type-checked against McpConnection.
 */
function createMockConnection(overrides: {
  client?: Client;
  serverInfo?: { name: string; version?: string };
  protocolVersion?: string;
  capabilities?: Record<string, unknown> | null;
}): McpConnection {
  const mockClient = overrides.client ?? ({ ping: async () => ({}) } as unknown as Client);

  // Use 'capabilities' in overrides to check if it was explicitly set
  const hasCapabilitiesOverride = 'capabilities' in overrides;

  return {
    client: mockClient,
    serverInfo: overrides.serverInfo ?? { name: 'test-server', version: '1.0.0' },
    protocolVersion: overrides.protocolVersion ?? '2025-11-25',
    capabilities: hasCapabilitiesOverride ? overrides.capabilities : { tools: {} },
    timeouts: { connect_ms: 10000, call_ms: 30000, run_ms: 300000 },
    close: async () => {
      /* no-op for mock */
    },
    callTool: async () => ({ content: [] }),
  } as unknown as McpConnection;
}

function createConfig(overrides: Partial<ConfigInput> = {}): Config {
  return testConfig({
    server: { transport: 'stdio', command: 'echo' },
    ...overrides,
  });
}

describe('Compliance Checks', () => {
  describe('Unit tests with mocked data', () => {
    it('passes when all compliance data is valid', async () => {
      const connection = createMockConnection({});
      const config = createConfig();

      const results = await runComplianceChecks({ connection, config });

      expect(results).toHaveLength(5); // handshake, protocol-version, server-info, capabilities, ping
      expect(results.every((r) => r.status === 'pass')).toBe(true);
    });

    it('fails when server name is empty', async () => {
      const connection = createMockConnection({
        serverInfo: { name: '', version: '1.0.0' },
      });
      const config = createConfig();

      const results = await runComplianceChecks({ connection, config });

      const serverInfoResult = results.find(
        (r) => r.id === 'compliance/server-info'
      );
      expect(serverInfoResult).toBeDefined();
      expect(serverInfoResult?.status).toBe('fail');
      expect(serverInfoResult?.message).toContain('did not provide a name');
    });

    it('warns when server version is empty', async () => {
      const connection = createMockConnection({
        serverInfo: { name: 'test-server', version: '' },
      });
      const config = createConfig();

      const results = await runComplianceChecks({ connection, config });

      const serverInfoResult = results.find(
        (r) => r.id === 'compliance/server-info'
      );
      expect(serverInfoResult).toBeDefined();
      expect(serverInfoResult?.status).toBe('warn');
      expect(serverInfoResult?.message).toContain('did not provide a version');
    });

    it('fails when protocol version is missing', async () => {
      const connection = createMockConnection({
        protocolVersion: '',
      });
      const config = createConfig();

      const results = await runComplianceChecks({ connection, config });

      const versionResult = results.find(
        (r) => r.id === 'compliance/protocol-version'
      );
      expect(versionResult).toBeDefined();
      expect(versionResult?.status).toBe('fail');
      expect(versionResult?.message).toContain(
        'did not negotiate a protocol version'
      );
    });

    it('fails when protocol version is "unknown"', async () => {
      const connection = createMockConnection({
        protocolVersion: 'unknown',
      });
      const config = createConfig();

      const results = await runComplianceChecks({ connection, config });

      const versionResult = results.find(
        (r) => r.id === 'compliance/protocol-version'
      );
      expect(versionResult).toBeDefined();
      expect(versionResult?.status).toBe('fail');
    });

    it('warns when protocol version has unusual format', async () => {
      const connection = createMockConnection({
        protocolVersion: 'contains spaces or $pecial',
      });
      const config = createConfig();

      const results = await runComplianceChecks({ connection, config });

      const versionResult = results.find(
        (r) => r.id === 'compliance/protocol-version'
      );
      expect(versionResult).toBeDefined();
      expect(versionResult?.status).toBe('warn');
      expect(versionResult?.message).toContain('unusual format');
    });

    it('fails when capabilities are undefined', async () => {
      const connection = createMockConnection({
        capabilities: undefined as unknown as Record<string, unknown>,
      });
      const config = createConfig();

      const results = await runComplianceChecks({ connection, config });

      const capResult = results.find((r) => r.id === 'compliance/capabilities');
      expect(capResult).toBeDefined();
      expect(capResult?.status).toBe('fail');
      expect(capResult?.message).toContain('did not declare capabilities');
    });

    it('fails when ping throws an error', async () => {
      const mockClient = {
        ping: async () => {
          throw new Error('Connection refused');
        },
      } as unknown as Client;

      const connection = createMockConnection({ client: mockClient });
      const config = createConfig();

      const results = await runComplianceChecks({ connection, config });

      const pingResult = results.find((r) => r.id === 'compliance/ping');
      expect(pingResult).toBeDefined();
      expect(pingResult?.status).toBe('fail');
      expect(pingResult?.message).toContain('failed to respond to ping');
      expect(pingResult?.message).toContain('Connection refused');
    });

    it('fails when expected protocol version does not match', async () => {
      const connection = createMockConnection({
        protocolVersion: '2024-01-01',
      });
      const config = createConfig({
        expect: {
          protocol_version: '2025-11-25',
        },
      });

      const results = await runComplianceChecks({ connection, config });

      const expectedVersionResult = results.find(
        (r) => r.id === 'compliance/expected-protocol-version'
      );
      expect(expectedVersionResult).toBeDefined();
      expect(expectedVersionResult?.status).toBe('fail');
      expect(expectedVersionResult?.message).toContain('mismatch');
      expect(expectedVersionResult?.expected).toBe('2025-11-25');
      expect(expectedVersionResult?.actual).toBe('2024-01-01');
    });

    it('passes when expected protocol version matches', async () => {
      const connection = createMockConnection({
        protocolVersion: '2025-11-25',
      });
      const config = createConfig({
        expect: {
          protocol_version: '2025-11-25',
        },
      });

      const results = await runComplianceChecks({ connection, config });

      const expectedVersionResult = results.find(
        (r) => r.id === 'compliance/expected-protocol-version'
      );
      expect(expectedVersionResult).toBeDefined();
      expect(expectedVersionResult?.status).toBe('pass');
    });

    it('skips expected protocol version check when not configured', async () => {
      const connection = createMockConnection({});
      const config = createConfig(); // No expect.protocol_version

      const results = await runComplianceChecks({ connection, config });

      const expectedVersionResult = results.find(
        (r) => r.id === 'compliance/expected-protocol-version'
      );
      expect(expectedVersionResult).toBeUndefined();
    });
  });

  describe('Integration with good-server', () => {
    let connection: McpConnection | null = null;

    beforeAll(async () => {
      // Connect to good-server through the real client path
      connection = await connect(
        testConfig({
          server: { transport: 'stdio', command: 'npx', args: ['tsx', './fixtures/good-server/index.ts'] },
        })
      );
    }, 30000);

    afterAll(async () => {
      if (connection) {
        await connection.close();
      }
    });

    it('passes all compliance checks against good-server', async () => {
      if (!connection) {
        throw new Error('Connection not established');
      }

      const config = createConfig();
      const results = await runComplianceChecks({ connection, config });

      // All checks should pass
      const failures = results.filter((r) => r.status === 'fail');
      expect(failures).toHaveLength(0);

      // Should have the expected checks
      const ids = results.map((r) => r.id);
      expect(ids).toContain('compliance/handshake');
      expect(ids).toContain('compliance/protocol-version');
      expect(ids).toContain('compliance/server-info');
      expect(ids).toContain('compliance/capabilities');
      expect(ids).toContain('compliance/ping');
    }, 30000);
  });
});
