/**
 * Description collision lint tests (M4).
 *
 * The negatives matter most: a collision lint that flags ordinary tool families
 * (list_users / list_projects) trains users to ignore it.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { connect } from '../../src/client/connect.js';
import {
  runCollisionChecks,
  findCollisions,
  requiredShape,
  requiredShapeOrDepth,
  DEFAULT_COLLISION_THRESHOLD,
} from '../../src/checks/collision.js';
import { trigramDiceScorer } from '../../src/checks/similarity.js';
import { schemaNestingDepth } from '../../src/surface/canonical.js';
import type { Tool } from '../../src/checks/schema.js';
import type { Config } from '../../src/config/schema.js';
import { testConfig } from '../helpers/config.js';

const FIXTURES = join(process.cwd(), 'fixtures');
const serverConfig = (name: string): Config =>
  testConfig({
    server: {
      transport: 'stdio',
      command: 'npx',
      args: ['tsx', join(FIXTURES, name, 'index.ts')],
      env: {},
    },
    checks: {},
    suites: [],
  });

const tool = (name: string, description: string, inputSchema: Tool['inputSchema']): Tool => ({
  name,
  description,
  inputSchema,
});

describe('trigramDiceScorer', () => {
  it('is 1 for texts identical after normalization, 0 for empty', () => {
    expect(trigramDiceScorer.score('Reads a FILE.', 'reads a file')).toBe(1);
    expect(trigramDiceScorer.score('', 'x')).toBe(0);
  });

  it('is symmetric', () => {
    const a = 'Find orders matching a filter.';
    const b = 'Find orders by status.';
    expect(trigramDiceScorer.score(a, b)).toBeCloseTo(trigramDiceScorer.score(b, a), 10);
  });

  it('ranks a one-word change above an unrelated description', () => {
    const base = 'Find orders matching the given filter. Returns a list of orders.';
    const near = trigramDiceScorer.score(base, base.replace('filter', 'status'));
    const far = trigramDiceScorer.score(base, 'Sends an email to a recipient.');
    expect(near).toBeGreaterThan(0.8);
    expect(far).toBeLessThan(0.3);
  });
});

describe('schemaNestingDepth', () => {
  it.each([
    [{ type: 'object', properties: { a: { type: 'string' } } }, 1],
    [
      {
        type: 'object',
        properties: { f: { type: 'object', properties: { s: { type: 'string' } } } },
      },
      2,
    ],
    [{ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } }, 1],
    [
      {
        type: 'object',
        properties: { rows: { type: 'array', items: { type: 'object', properties: { id: {} } } } },
      },
      2,
    ],
    [{ type: 'object', properties: {} }, 1],
    [{ anyOf: [{ type: 'string' }, { type: 'object', properties: { x: {} } }] }, 1],
  ])('%j → %i', (schema, depth) => {
    expect(schemaNestingDepth(schema)).toBe(depth);
  });

  it('rejects hostile nesting cleanly', () => {
    let s: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 100; i++) s = { type: 'object', properties: { n: s } };
    expect(() => schemaNestingDepth(s)).toThrow(/maximum depth/);
  });
});

describe('divergence predicate', () => {
  it('ignores required param NAMES, compares their types', () => {
    expect(
      requiredShape({ properties: { user_id: { type: 'string' } }, required: ['user_id'] })
    ).toEqual(['string']);
    expect(
      requiredShapeOrDepth(
        { properties: { user_id: { type: 'string' } }, required: ['user_id'] },
        { properties: { project_id: { type: 'string' } }, required: ['project_id'] }
      )
    ).toEqual([]);
  });

  it('reports both reasons for nested-object vs flat-scalar', () => {
    const reasons = requiredShapeOrDepth(
      { properties: { filter: { type: 'object', properties: { s: {} } } }, required: ['filter'] },
      { properties: { status: { type: 'string' } }, required: ['status'] }
    );
    expect(reasons.map((r) => r.kind)).toEqual(['required-shape', 'depth']);
  });
});

describe('findCollisions (pure)', () => {
  const flat = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] };
  const nested = {
    type: 'object',
    properties: { filter: { type: 'object', properties: { status: { type: 'string' } } } },
    required: ['filter'],
  };

  it('requires BOTH similarity and divergence', () => {
    const desc = 'Find orders matching the given filter. Returns a list of orders.';
    expect(findCollisions([tool('a', desc, nested), tool('b', desc, flat)])).toHaveLength(1);
    expect(findCollisions([tool('a', desc, flat), tool('b', desc, flat)])).toHaveLength(0);
    expect(
      findCollisions([tool('a', desc, nested), tool('b', 'Sends an email.', flat)])
    ).toHaveLength(0);
  });

  it('respects the threshold', () => {
    const tools = [
      tool('a', 'Find orders by filter.', nested),
      tool('b', 'Find orders by status.', flat),
    ];
    const score = trigramDiceScorer.score('Find orders by filter.', 'Find orders by status.');
    expect(findCollisions(tools, { threshold: score - 0.01 })).toHaveLength(1);
    expect(findCollisions(tools, { threshold: score + 0.01 })).toHaveLength(0);
  });

  it('skips tools without descriptions and orders pairs deterministically', () => {
    const desc = 'Find orders matching the given filter.';
    const findings = findCollisions([
      tool('zeta', desc, flat),
      tool('alpha', desc, nested),
      tool('none', '', flat),
    ]);
    expect(findings.map((f) => [f.a, f.b])).toEqual([['alpha', 'zeta']]);
    // reasons are oriented to the (a, b) order
    expect(findings[0]?.reasons[0]).toEqual({
      kind: 'required-shape',
      a: ['object'],
      b: ['string'],
    });
  });
});

describe('runCollisionChecks against collision-server', () => {
  it('negative family pairs score ABOVE the threshold — the gate, not the scorer, silences them', () => {
    const pairs = [
      [
        'Lists all users in the workspace, newest first.',
        'Lists all projects in the workspace, newest first.',
      ],
      [
        'Gets a single user record by its unique identifier.',
        'Gets a single project record by its unique identifier.',
      ],
    ] as const;
    for (const [a, b] of pairs) {
      expect(trigramDiceScorer.score(a, b)).toBeGreaterThanOrEqual(DEFAULT_COLLISION_THRESHOLD);
    }
  });

  it('flags exactly the true collision (negatives stay silent)', async () => {
    const connection = await connect(serverConfig('collision-server'));
    try {
      const results = await runCollisionChecks({ connection });
      const findings = results.filter((r) => r.id === 'collision/description-collision');
      expect(findings.map((r) => r.location)).toEqual(['find_orders / search_orders']);
      expect(findings[0]?.status).toBe('warn');
      expect(findings[0]?.severity).toBe('warning');
      expect(findings[0]?.message).toContain('required params [string] vs [object]');
      expect(findings[0]?.message).toContain('nesting depth 1 vs 2');
    } finally {
      await connection.close();
    }
  });

  it('fail: true makes findings fail the run', async () => {
    const connection = await connect(serverConfig('collision-server'));
    try {
      const results = await runCollisionChecks({ connection, config: { fail: true } });
      expect(results.find((r) => r.id === 'collision/description-collision')?.status).toBe('fail');
    } finally {
      await connection.close();
    }
  });

  it('skips with a warning above max_tools instead of hanging', async () => {
    const connection = await connect(serverConfig('collision-server'));
    try {
      const results = await runCollisionChecks({ connection, config: { max_tools: 3 } });
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe('skip');
      expect(results[0]?.message).toContain('max_tools');
    } finally {
      await connection.close();
    }
  });

  it.each(['good-server', 'poisoned-server', 'malformed-server', 'error-contract-server'])(
    '%s: zero collision findings',
    async (name) => {
      const connection = await connect(serverConfig(name));
      try {
        const results = await runCollisionChecks({ connection });
        expect(results.filter((r) => r.id === 'collision/description-collision')).toEqual([]);
      } finally {
        await connection.close();
      }
    }
  );
});
