/**
 * Latency check tests
 *
 * Tests latency budget validation:
 * - good-server: fast, should pass any reasonable budget
 * - slow-server: slow, should FAIL tight budgets
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { connect } from '../../src/client/connect.js';
import { runLatencyChecks } from '../../src/checks/latency.js';
import type { Config } from '../../src/config/schema.js';

// Fixture paths
const FIXTURES_DIR = join(process.cwd(), 'fixtures');
const GOOD_SERVER = join(FIXTURES_DIR, 'good-server', 'index.ts');
const SLOW_SERVER = join(FIXTURES_DIR, 'slow-server', 'index.ts');

// Config for good server with latency checks
const goodServerConfig: Config = {
  server: {
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', GOOD_SERVER],
    env: {},
  },
  checks: {
    latency: {
      samples: 3,
      p95_budget_ms: 5000, // 5 seconds - generous for good server
    },
  },
  suites: [],
};

// Config for slow server with tight budget (should fail)
const slowServerConfigTightBudget: Config = {
  server: {
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', SLOW_SERVER],
    env: {},
  },
  checks: {
    latency: {
      samples: 2, // Fewer samples to keep test fast
      p95_budget_ms: 500, // 500ms - too tight for slow-server
    },
  },
  suites: [],
};

// Config for slow server with loose budget (should pass)
const slowServerConfigLooseBudget: Config = {
  server: {
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', SLOW_SERVER],
    env: {},
  },
  checks: {
    latency: {
      samples: 2,
      p95_budget_ms: 10000, // 10 seconds - loose enough for slow-server
    },
  },
  suites: [],
};

describe('Latency Checks', () => {
  describe('against good-server', () => {
    it('passes with generous budget', async () => {
      const connection = await connect(goodServerConfig);
      try {
        const results = await runLatencyChecks({
          connection,
          config: goodServerConfig.checks?.latency ?? { samples: 5, p95_budget_ms: 1000 },
        });

        const summary = results.find((r) => r.id === 'latency/summary');
        expect(summary).toBeDefined();
        expect(summary?.status).toBe('pass');
        expect(summary?.message).toContain('p50=');
        expect(summary?.message).toContain('p95=');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('measures latency for each tool', async () => {
      const connection = await connect(goodServerConfig);
      try {
        const results = await runLatencyChecks({
          connection,
          config: goodServerConfig.checks?.latency ?? { samples: 5, p95_budget_ms: 1000 },
        });

        const toolResults = results.filter((r) => r.id === 'latency/tool');
        expect(toolResults.length).toBeGreaterThan(0);

        for (const result of toolResults) {
          expect(result.message).toContain('min=');
          expect(result.message).toContain('p50=');
          expect(result.message).toContain('p95=');
          expect(result.message).toContain('max=');
        }
      } finally {
        await connection.close();
      }
    }, 30000);
  });

  describe('against slow-server', () => {
    it('FAILS with tight budget', async () => {
      const connection = await connect(slowServerConfigTightBudget);
      try {
        const results = await runLatencyChecks({
          connection,
          config: slowServerConfigTightBudget.checks?.latency ?? { samples: 5, p95_budget_ms: 1000 },
        });

        const summary = results.find((r) => r.id === 'latency/summary');
        expect(summary).toBeDefined();
        expect(summary?.status).toBe('fail');
        expect(summary?.message).toContain('budget');
      } finally {
        await connection.close();
      }
    }, 60000); // Longer timeout for slow server

    it('PASSES with loose budget', async () => {
      const connection = await connect(slowServerConfigLooseBudget);
      try {
        const results = await runLatencyChecks({
          connection,
          config: slowServerConfigLooseBudget.checks?.latency ?? { samples: 5, p95_budget_ms: 1000 },
        });

        const summary = results.find((r) => r.id === 'latency/summary');
        expect(summary).toBeDefined();
        expect(summary?.status).toBe('pass');
      } finally {
        await connection.close();
      }
    }, 60000); // Longer timeout for slow server

    it('measures high latency values', async () => {
      const connection = await connect(slowServerConfigTightBudget);
      try {
        const results = await runLatencyChecks({
          connection,
          config: slowServerConfigTightBudget.checks?.latency ?? { samples: 5, p95_budget_ms: 1000 },
        });

        const toolResults = results.filter((r) => r.id === 'latency/tool');
        expect(toolResults.length).toBeGreaterThan(0);

        // At least one tool should have high latency (always_slow is 2000ms)
        const slowToolResult = toolResults.find(
          (r) => r.location === 'always_slow'
        );
        if (slowToolResult) {
          // The actual latencies should be high
          const actual = slowToolResult.actual as {
            min: number;
            p50: number;
            p95: number;
            max: number;
          };
          expect(actual.min).toBeGreaterThan(1000); // Should be > 1 second
        }
      } finally {
        await connection.close();
      }
    }, 60000);
  });
});
