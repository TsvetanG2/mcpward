/**
 * `mcpward diff` output parity with `run` (M6.4).
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect } from '../../src/client/connect.js';
import { captureServerSurface, saveLockfile } from '../../src/surface/index.js';
import { diffCommand } from '../../src/commands/diff.js';
import { sarifArtifactUri, repoRoot } from '../../src/commands/output.js';
import { testConfig } from '../helpers/config.js';

const FIXTURES = join(process.cwd(), 'fixtures', 'drift');

describe('mcpward diff', () => {
  let dir: string;
  let baseline: string;

  const config = (version: 'v1' | 'v2') =>
    testConfig({
      server: {
        transport: 'stdio',
        command: 'npx',
        args: ['tsx', join(FIXTURES, version, 'index.ts')],
      },
      checks: { drift: { baseline } },
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpward-diff-'));
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
  afterEach(() => vi.restoreAllMocks());

  function captureStdout() {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return lines;
  }

  it('writes SARIF with the drift findings (reporters shared with run)', async () => {
    captureStdout();
    const out = join(dir, 'drift.sarif');
    const code = await diffCommand(config('v2'), { config: 'x', reporter: 'sarif', out });
    expect(code).toBe(1);

    const sarif = JSON.parse(await readFile(out, 'utf-8')) as {
      version: string;
      runs: { results: { ruleId: string }[] }[];
    };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]?.results.map((r) => r.ruleId)).toContain('drift-description_changed');
  }, 30000);

  it('anchors SARIF alerts to the config file actually used, not always mcpward.yaml', async () => {
    captureStdout();
    const out = join(dir, 'anchored.sarif');
    await diffCommand(config('v2'), {
      config: join('ci', 'mcp-checks.yaml'),
      reporter: 'sarif',
      out,
    });
    const sarif = JSON.parse(await readFile(out, 'utf-8')) as {
      runs: {
        results: { locations: { physicalLocation?: { artifactLocation: { uri: string } } }[] }[];
      }[];
    };
    const uris = new Set(
      sarif.runs[0]?.results.flatMap((r) =>
        r.locations.map((l) => l.physicalLocation?.artifactLocation.uri)
      )
    );
    expect([...uris]).toEqual(['ci/mcp-checks.yaml']);
  }, 30000);

  it('SARIF URIs are relative to the repository root, not the working directory', () => {
    // e.g. the action's working-directory: service, config at the repo root
    const root = join(dir, 'repo');
    expect(sarifArtifactUri(join(root, 'mcpward.yaml'), root)).toBe('mcpward.yaml');
    expect(sarifArtifactUri(join(root, 'ci', 'mcp.yaml'), root)).toBe('ci/mcp.yaml');
    expect(repoRoot(join(dir, 'anywhere'), { GITHUB_WORKSPACE: root })).toBe(root);
  });

  it('SARIF URIs percent-encode each path segment (# and spaces)', () => {
    const root = join(dir, 'repo');
    expect(sarifArtifactUri(join(root, 'ci', 'checks#prod.yaml'), root)).toBe('ci/checks%23prod.yaml');
    expect(sarifArtifactUri(join(root, 'my checks', 'mcp.yaml'), root)).toBe('my%20checks/mcp.yaml');
  });

  it('--json prints the full report and nothing else on stdout', async () => {
    const lines = captureStdout();
    await diffCommand(config('v2'), { config: 'x', json: true });

    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0] ?? '') as { summary: unknown; results: { id: string }[] };
    expect(report.summary).toBeDefined();
    expect(report.results.map((r) => r.id)).toContain('drift/description_changed');
  }, 30000);

  it('exits 0 against an unchanged server', async () => {
    captureStdout();
    expect(await diffCommand(config('v1'), { config: 'x', reporter: 'json' })).toBe(0);
  }, 30000);
});
