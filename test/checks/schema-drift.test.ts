/**
 * Schema drift against real fixture servers (M6.3): drift/schema-v1 → schema-v2.
 * Ground truth lives in fixtures/drift/schema-common.ts — one change per tool.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect } from '../../src/client/connect.js';
import { captureServerSurface, saveLockfile } from '../../src/surface/index.js';
import { runDriftChecks } from '../../src/checks/drift.js';
import { testConfig } from '../helpers/config.js';

const FIXTURES = join(process.cwd(), 'fixtures', 'drift');

describe('schema drift fixtures (schema-v1 → schema-v2)', () => {
  let dir: string;
  let baseline: string;

  const config = (v: 'v1' | 'v2') =>
    testConfig({
      server: {
        transport: 'stdio',
        command: 'npx',
        args: ['tsx', join(FIXTURES, `schema-${v}`, 'index.ts')],
      },
      checks: { drift: { baseline, fail_on: 'medium' } },
    });

  const drift = async (v: 'v1' | 'v2') => {
    const cfg = config(v);
    const connection = await connect(cfg);
    try {
      return await runDriftChecks({ connection, fullConfig: cfg, config: cfg.checks?.drift });
    } finally {
      await connection.close();
    }
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpward-schema-drift-'));
    baseline = join(dir, 'baseline.lock.json');
    const cfg = config('v1');
    const connection = await connect(cfg);
    try {
      await saveLockfile(await captureServerSurface(connection, cfg), baseline);
    } finally {
      await connection.close();
    }
  }, 30000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports exactly one finding per changed tool, with the ground-truth class', async () => {
    const results = await drift('v2');
    const findings = results
      .filter((r) => r.location && r.id.startsWith('drift/') && !r.id.includes('summary'))
      .map((r) => `${r.location}:${r.id}`)
      .sort();

    expect(findings).toEqual([
      'closed_object:drift/breaking_schema_change',
      'enum_added:drift/nonbreaking_schema_change',
      'enum_removed:drift/breaking_schema_change',
      'items_narrowed:drift/breaking_schema_change',
      'max_raised:drift/nonbreaking_schema_change',
      'min_raised:drift/breaking_schema_change',
      'nested_enum:drift/breaking_schema_change',
      'param_description:drift/description_changed',
      'pattern_added:drift/breaking_schema_change',
    ]);
  }, 30000);

  it('fails the run on the breaking ones under fail_on: medium', async () => {
    const results = await drift('v2');
    const failing = results
      .filter((r) => r.status === 'fail' && r.location)
      .map((r) => r.location)
      .sort();
    expect(failing).toEqual([
      'closed_object',
      'enum_removed',
      'items_narrowed',
      'min_raised',
      'nested_enum',
      'param_description',
      'pattern_added',
    ]);
  }, 30000);

  it('NEGATIVE: the same server against its own baseline yields no drift', async () => {
    const results = await drift('v1');
    expect(results.find((r) => r.id === 'drift/no-changes')?.status).toBe('pass');
  }, 30000);
});
