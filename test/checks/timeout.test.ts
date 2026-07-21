/**
 * Timeout tests
 *
 * Tests that mcpward properly times out when servers hang.
 */

import { describe, it, expect } from 'vitest';
import { connect } from '../../src/client/connect.js';
import type { Config } from '../../src/config/schema.js';

const HANGING_SERVER_CONFIG: Config = {
  server: {
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', './fixtures/hanging-server/index.ts'],
    env: {},
  },
  timeouts: {
    connect_ms: 5000,
    call_ms: 2000, // Short timeout for testing
    run_ms: 30000,
  },
  checks: {},
  suites: [],
};

describe('Timeout Handling', () => {
  it('connects successfully to hanging-server', async () => {
    const connection = await connect(HANGING_SERVER_CONFIG);
    expect(connection.serverInfo.name).toBe('hanging-server');
    await connection.close();
  }, 10000);

  it('times out on hung tool call', async () => {
    const connection = await connect(HANGING_SERVER_CONFIG);

    try {
      await expect(
        connection.callTool({ name: 'hang_forever', arguments: {} })
      ).rejects.toThrow(/Timeout.*tool call.*hang_forever.*2000ms/);
    } finally {
      await connection.close();
    }
  }, 15000);

  it('quick_response works normally', async () => {
    const connection = await connect(HANGING_SERVER_CONFIG);

    try {
      const result = await connection.callTool({
        name: 'quick_response',
        arguments: {},
      });
      expect(result).toBeDefined();
    } finally {
      await connection.close();
    }
  }, 10000);
});
