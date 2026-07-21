/**
 * Compliance check tests
 *
 * Tests protocol compliance checks including negative cases
 * where the server returns invalid data.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runComplianceChecks } from '../../src/checks/compliance.js';
import type { McpConnection } from '../../src/client/connect.js';
import type { Config } from '../../src/config/schema.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Creates a mock connection for testing compliance checks.
 */
function createMockConnection(overrides: {
  serverInfo?: { name: string; version?: string };
  protocolVersion?: string;
  capabilities?: Record<string, unknown> | null;
}): McpConnection {
  const mockClient = {
    ping: async () => ({}),
  } as unknown as Client;

  // Use 'capabilities' in overrides to check if it was explicitly set
  const hasCapabilitiesOverride = 'capabilities' in overrides;

  return {
    client: mockClient,
    serverInfo: overrides.serverInfo ?? { name: 'test-server', version: '1.0.0' },
    protocolVersion: overrides.protocolVersion ?? '2025-11-25',
    capabilities: hasCapabilitiesOverride
      ? (overrides.capabilities as Record<string, unknown>)
      : { tools: {} },
    close: async () => { /* no-op for mock */ },
    transport: {} as StdioClientTransport,
  };
}

function createConfig(overrides: Partial<Config> = {}): Config {
  return {
    server: { transport: 'stdio', command: 'echo' },
    ...overrides,
  } as Config;
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

      const connection: McpConnection = {
        client: mockClient,
        serverInfo: { name: 'test-server', version: '1.0.0' },
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        close: async () => { /* no-op for mock */ },
        transport: {} as StdioClientTransport,
      };
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
      // Connect to good-server
      const transport = new StdioClientTransport({
        command: 'npx',
        args: ['tsx', './fixtures/good-server/index.ts'],
      });
      const client = new Client({ name: 'test-client', version: '1.0.0' }, {});
      await client.connect(transport);

      // Get server info from the initialize response
      const serverInfo = { name: 'good-server', version: '1.0.0' };
      const protocolVersion = '2024-11-05';
      const capabilities = { tools: {} };

      connection = {
        client,
        serverInfo,
        protocolVersion,
        capabilities,
        close: async () => {
          await transport.close();
        },
        transport,
      };
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
