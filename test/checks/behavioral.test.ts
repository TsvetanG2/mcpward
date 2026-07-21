/**
 * Behavioral check tests
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { connect } from '../../src/client/connect.js';
import { runBehavioralChecks } from '../../src/checks/behavioral.js';
import type { Config, TestSuite } from '../../src/config/schema.js';

// Fixture paths
const FIXTURES_DIR = join(process.cwd(), 'fixtures');
const GOOD_SERVER = join(FIXTURES_DIR, 'good-server', 'index.ts');

// Config for good server
const makeConfig = (suites: TestSuite[]): Config => ({
  server: {
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', GOOD_SERVER],
    env: {},
  },
  checks: {},
  suites,
});

describe('Behavioral Checks', () => {
  describe('against good-server', () => {
    it('runs test case without expectations (smoke test)', async () => {
      const config = makeConfig([
        {
          tool: 'echo',
          cases: [
            {
              name: 'basic echo',
              args: { message: 'hello' },
            },
          ],
        },
      ]);

      const connection = await connect(config);
      try {
        const results = await runBehavioralChecks({
          connection,
          suites: config.suites,
        });

        const caseResult = results.find(
          (r) => r.id === 'behavioral/case' && r.location === 'echo/basic echo'
        );
        expect(caseResult?.status).toBe('pass');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('asserts tool_is_error: false', async () => {
      const config = makeConfig([
        {
          tool: 'may_fail',
          cases: [
            {
              name: 'success case',
              args: { fail: false },
              expect: { tool_is_error: false },
            },
          ],
        },
      ]);

      const connection = await connect(config);
      try {
        const results = await runBehavioralChecks({
          connection,
          suites: config.suites,
        });

        const isErrorResult = results.find(
          (r) => r.id === 'behavioral/tool-is-error'
        );
        expect(isErrorResult?.status).toBe('pass');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('asserts tool_is_error: true', async () => {
      const config = makeConfig([
        {
          tool: 'may_fail',
          cases: [
            {
              name: 'failure case',
              args: { fail: true },
              expect: { tool_is_error: true },
            },
          ],
        },
      ]);

      const connection = await connect(config);
      try {
        const results = await runBehavioralChecks({
          connection,
          suites: config.suites,
        });

        const isErrorResult = results.find(
          (r) => r.id === 'behavioral/tool-is-error'
        );
        expect(isErrorResult?.status).toBe('pass');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('asserts jsonpath on result', async () => {
      const config = makeConfig([
        {
          tool: 'echo',
          cases: [
            {
              name: 'jsonpath assertion',
              args: { message: 'test message' },
              expect: {
                jsonpath: {
                  '$.content[0].type': 'text',
                  '$.content[0].text': 'test message',
                },
              },
            },
          ],
        },
      ]);

      const connection = await connect(config);
      try {
        const results = await runBehavioralChecks({
          connection,
          suites: config.suites,
        });

        const jsonpathResult = results.find(
          (r) => r.id === 'behavioral/jsonpath'
        );
        expect(jsonpathResult?.status).toBe('pass');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('fails on wrong tool_is_error expectation', async () => {
      const config = makeConfig([
        {
          tool: 'may_fail',
          cases: [
            {
              name: 'wrong expectation',
              args: { fail: false },
              expect: { tool_is_error: true }, // Wrong!
            },
          ],
        },
      ]);

      const connection = await connect(config);
      try {
        const results = await runBehavioralChecks({
          connection,
          suites: config.suites,
        });

        const isErrorResult = results.find(
          (r) => r.id === 'behavioral/tool-is-error'
        );
        expect(isErrorResult?.status).toBe('fail');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('fails on nonexistent tool', async () => {
      const config = makeConfig([
        {
          tool: 'nonexistent_tool',
          cases: [
            {
              name: 'should not run',
              args: {},
            },
          ],
        },
      ]);

      const connection = await connect(config);
      try {
        const results = await runBehavioralChecks({
          connection,
          suites: config.suites,
        });

        const toolExistsResult = results.find(
          (r) => r.id === 'behavioral/tool-exists'
        );
        expect(toolExistsResult?.status).toBe('fail');
        expect(toolExistsResult?.message).toContain('not found');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('returns empty array when no suites defined', async () => {
      const config = makeConfig([]);

      const connection = await connect(config);
      try {
        const results = await runBehavioralChecks({
          connection,
          suites: [],
        });

        expect(results).toHaveLength(0);
      } finally {
        await connection.close();
      }
    }, 30000);
  });
});
