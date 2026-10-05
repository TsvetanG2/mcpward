/**
 * Output shape drift integration tests (M3) against drift/output-v1 → output-v2.
 * Ground truth lives in fixtures/drift/output-common.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { rm, mkdir } from 'fs/promises';
import { connect } from '../../src/client/connect.js';
import { captureSurface, saveLockfile } from '../../src/surface/index.js';
import { runDriftChecks } from '../../src/checks/drift.js';
import type { Config } from '../../src/config/schema.js';

const FIXTURES = join(process.cwd(), 'fixtures', 'drift');
const V1 = join(FIXTURES, 'output-v1', 'index.ts');
const V2 = join(FIXTURES, 'output-v2', 'index.ts');
const TEMP_DIR = join(process.cwd(), 'test', '.temp-output-drift');
const BASELINE = join(TEMP_DIR, 'output.lock.json');

type OutputCfg = NonNullable<NonNullable<NonNullable<Config['checks']>['drift']>['output']>;

function config(server: string, output: Partial<OutputCfg> = {}): Config {
  return {
    server: { transport: 'stdio', command: 'npx', args: ['tsx', server], env: {} },
    checks: {
      drift: {
        baseline: BASELINE,
        fail_on: 'medium',
        full_text: true,
        severity: {},
        output: { enabled: true, shape_samples: 3, call_readonly: true, tools: [], ...output },
      },
    },
    suites: [],
  };
}

async function baselineFrom(cfg: Config) {
  const connection = await connect(cfg);
  try {
    const captured = await captureSurface(connection, cfg);
    await saveLockfile(captured.surface, BASELINE);
    return captured;
  } finally {
    await connection.close();
  }
}

async function driftAgainst(cfg: Config) {
  const connection = await connect(cfg);
  try {
    return await runDriftChecks({ connection, fullConfig: cfg, config: cfg.checks?.drift });
  } finally {
    await connection.close();
  }
}

const outputFindings = (results: Awaited<ReturnType<typeof driftAgainst>>) =>
  results
    .filter((r) => r.id.includes('output_shape_change'))
    .map((r) => `${r.location}:${r.id}`)
    .sort();

describe('Output shape drift (M3)', () => {
  beforeAll(async () => {
    await mkdir(TEMP_DIR, { recursive: true });
  });
  afterAll(async () => {
    await rm(TEMP_DIR, { recursive: true, force: true });
  });

  it('baseline samples only safe tools and records why others were not called', async () => {
    const { surface, notes } = await baselineFrom(config(V1));
    const sampled = Object.keys(surface.tools)
      .filter((t) => surface.tools[t]?.outputShape)
      .sort();
    expect(sampled).toEqual(['get_feed', 'get_metrics', 'get_profile', 'get_status', 'say_hello']);
    expect(surface.tools.get_status?.outputShape?.samples).toBe(3);

    const byTool = Object.fromEntries(notes.map((n) => [n.tool, n.status]));
    expect(byTool).toEqual({ lookup: 'skipped', wipe_data: 'refused' });
  });

  it('NEGATIVE: same server, varying values → zero output findings', async () => {
    await baselineFrom(config(V1));
    const results = await driftAgainst(config(V1));
    expect(outputFindings(results)).toEqual([]);
    expect(results.find((r) => r.id === 'drift/no-changes')?.status).toBe('pass');
  });

  it('POSITIVE: v1 → v2 reports exactly the ground-truth changes', async () => {
    await baselineFrom(config(V1));
    const results = await driftAgainst(config(V2));
    expect(outputFindings(results)).toEqual([
      'get_metrics:drift/nonbreaking_output_shape_change',
      'get_profile:drift/breaking_output_shape_change',
      'get_status:drift/breaking_output_shape_change',
    ]);

    // Breaking output changes fail at fail_on: medium; the added field does not
    const status = results.find(
      (r) => r.location === 'get_status' && r.id.startsWith('drift/breaking')
    );
    expect(status?.status).toBe('fail');
    expect(status?.message).toContain('$.uptime');
    const metrics = results.find((r) => r.location === 'get_metrics');
    expect(metrics?.status).toBe('pass');

    // The destructive tool was never called — otherwise its changed shape would show up
    expect(results.some((r) => r.location === 'wipe_data' && r.id.includes('output_shape'))).toBe(
      false
    );
    expect(results.find((r) => r.location === 'wipe_data')?.message).toContain('refused');

    // Input schemas are identical: no input-side drift
    expect(results.some((r) => r.id === 'drift/breaking_schema_change')).toBe(false);
  });

  it('allowlisted tool with args is sampled and its drift detected', async () => {
    const lookup = { tools: [{ name: 'lookup', args: { id: 'r1' } }] };
    await baselineFrom(config(V1, lookup));
    const results = await driftAgainst(config(V2, lookup));
    expect(outputFindings(results)).toContain('lookup:drift/breaking_output_shape_change');
  });

  it('disabled by default: nothing is called, nothing is recorded', async () => {
    const cfg = config(V1);
    const drift = cfg.checks?.drift;
    if (drift) drift.output = undefined;
    const { surface, notes } = await baselineFrom(cfg);
    expect(notes).toEqual([]);
    expect(Object.values(surface.tools).some((t) => t.outputShape)).toBe(false);
  });
});
