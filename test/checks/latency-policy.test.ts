/**
 * Latency side-effect policy (1.1.0).
 *
 * Measuring latency means calling a tool `samples` times, so the check must only call tools
 * that cannot have side effects, unless the user allowlists them. These tests prove it
 * refuses — a policy that cannot say "no" is a bug.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect, type McpConnection } from '../../src/client/connect.js';
import {
  decideLatencyCall,
  runLatencyChecks,
  type LatencyCallPolicy,
} from '../../src/checks/latency.js';
import type { Tool } from '../../src/checks/schema.js';
import { latencyOf, testConfig } from '../helpers/config.js';

const OUTPUT_V1 = join(process.cwd(), 'fixtures', 'drift', 'output-v1', 'index.ts');

const DEFAULT_POLICY: LatencyCallPolicy = { call_readonly: true, tools: [], call_all: false };

function tool(annotations: Tool['annotations'], required: string[] = []): Tool {
  return {
    name: 't',
    description: 'd',
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(required.map((r) => [r, { type: 'string' }])),
      required,
    },
    annotations,
  };
}

describe('decideLatencyCall truth table', () => {
  const cases: [string, Tool['annotations'], Partial<LatencyCallPolicy>, boolean][] = [
    ['no annotations', undefined, {}, false],
    ['readOnlyHint: false', { readOnlyHint: false }, {}, false],
    ['destructiveHint only', { destructiveHint: true }, {}, false],
    ['readOnly', { readOnlyHint: true }, {}, true],
    [
      'readOnly + destructive (contradiction)',
      { readOnlyHint: true, destructiveHint: true },
      {},
      false,
    ],
    [
      'readOnly with call_readonly disabled',
      { readOnlyHint: true },
      { call_readonly: false },
      false,
    ],
    ['no annotations, allowlisted', undefined, { tools: [{ name: 't', args: { x: 1 } }] }, true],
    [
      'destructive, allowlisted',
      { destructiveHint: true },
      { tools: [{ name: 't', args: {} }] },
      true,
    ],
    ['no annotations, call_all', undefined, { call_all: true }, true],
    ['destructive, call_all', { destructiveHint: true }, { call_all: true }, true],
  ];

  it.each(cases)('%s → call=%s', (_label, annotations, policy, expected) => {
    const decision = decideLatencyCall(tool(annotations), { ...DEFAULT_POLICY, ...policy });
    expect(decision.call).toBe(expected);
    if (!decision.call) expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('allowlisted tools are called with the configured args', () => {
    const decision = decideLatencyCall(tool(undefined, ['id']), {
      ...DEFAULT_POLICY,
      tools: [{ name: 't', args: { id: 'abc' } }],
    });
    expect(decision).toEqual({ call: true, args: { id: 'abc' } });
  });

  it('read-only tools with required params get generated minimal args', () => {
    const decision = decideLatencyCall(tool({ readOnlyHint: true }, ['id']), DEFAULT_POLICY);
    expect(decision).toEqual({ call: true, args: { id: '' } });
  });
});

/** A connection that records every tool call instead of talking to a server. */
function recordingConnection(tools: Tool[]): { connection: McpConnection; called: string[] } {
  const called: string[] = [];
  const client = { listTools: async () => ({ tools }) } as unknown as Client;
  const connection = {
    client,
    callTool: async ({ name }: { name: string }) => {
      called.push(name);
      return { content: [] };
    },
  } as unknown as McpConnection;
  return { connection, called };
}

const latencyConfig = (extra: Partial<LatencyCallPolicy> = {}) => ({
  samples: 2,
  p95_budget_ms: 1000,
  ...DEFAULT_POLICY,
  ...extra,
});

describe('runLatencyChecks never calls tools the policy refuses', () => {
  const surface: Tool[] = [
    { ...tool({ readOnlyHint: true }), name: 'get_status' },
    { ...tool({ destructiveHint: true }), name: 'delete_all' },
    { ...tool(undefined), name: 'send_email' },
  ];

  it('default policy: only the read-only tool is called', async () => {
    const { connection, called } = recordingConnection(surface);
    const results = await runLatencyChecks({ connection, config: latencyConfig() });

    expect(new Set(called)).toEqual(new Set(['get_status']));
    expect(called).toHaveLength(2); // samples

    const sampling = results.find((r) => r.id === 'latency/sampling');
    expect(sampling?.status).toBe('skip');
    expect(sampling?.message).toContain('delete_all');
    expect(sampling?.message).toContain('send_email');
    expect(results.find((r) => r.id === 'latency/summary')?.status).toBe('pass');
  });

  it('nothing measurable: summary is skipped, not passed, and nothing is called', async () => {
    const { connection, called } = recordingConnection(surface.slice(1));
    const results = await runLatencyChecks({ connection, config: latencyConfig() });

    expect(called).toEqual([]);
    expect(results.find((r) => r.id === 'latency/summary')?.status).toBe('skip');
  });

  it('allowlisting a tool that is not on the server warns', async () => {
    const { connection } = recordingConnection(surface);
    const results = await runLatencyChecks({
      connection,
      config: latencyConfig({ tools: [{ name: 'no_such_tool', args: {} }] }),
    });
    const sampling = results.find((r) => r.id === 'latency/sampling');
    expect(sampling?.status).toBe('warn');
    expect(sampling?.message).toContain('no_such_tool');
  });

  it('call_all restores the pre-1.1.0 behavior', async () => {
    const { connection, called } = recordingConnection(surface);
    await runLatencyChecks({ connection, config: latencyConfig({ call_all: true }) });
    expect(new Set(called)).toEqual(new Set(['get_status', 'delete_all', 'send_email']));
  });
});

describe('against an annotated fixture server', () => {
  it('measures read-only tools and refuses the destructive one', async () => {
    const config = testConfig({
      server: { transport: 'stdio', command: 'npx', args: ['tsx', OUTPUT_V1] },
      checks: { latency: { samples: 1, p95_budget_ms: 10000 } },
    });
    const connection = await connect(config);
    try {
      const results = await runLatencyChecks({ connection, config: latencyOf(config) });
      const measured = results.filter((r) => r.id === 'latency/tool').map((r) => r.location);

      expect(measured).toContain('get_status');
      expect(measured).not.toContain('wipe_data');
      expect(results.find((r) => r.id === 'latency/sampling')?.message).toContain('wipe_data');
    } finally {
      await connection.close();
    }
  }, 30000);
});
