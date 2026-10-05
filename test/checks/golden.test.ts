/**
 * Golden snapshot tests (M6.2).
 *
 * `expect.golden` was documented and accepted by the config but never compared. These tests
 * pin the contract: missing file fails, mismatch fails, only --update-golden writes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { join } from 'path';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect, type McpConnection } from '../../src/client/connect.js';
import { runBehavioralChecks } from '../../src/checks/behavioral.js';
import type { TestSuite } from '../../src/config/schema.js';
import { testConfig } from '../helpers/config.js';

const GOOD_SERVER = join(process.cwd(), 'fixtures', 'good-server', 'index.ts');

const suites: TestSuite[] = [
  {
    tool: 'echo',
    cases: [{ name: 'echoes hello', args: { message: 'hello' }, expect: { golden: 'golden/echo.json' } }],
  },
];

describe('behavioral golden snapshots', () => {
  let connection: McpConnection;
  let baseDir: string;

  beforeAll(async () => {
    connection = await connect(
      testConfig({ server: { transport: 'stdio', command: 'npx', args: ['tsx', GOOD_SERVER] } })
    );
  }, 30000);
  afterAll(async () => {
    await connection.close();
  });
  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'mcpward-golden-'));
    return () => rm(baseDir, { recursive: true, force: true });
  });

  const golden = (results: Awaited<ReturnType<typeof runBehavioralChecks>>) =>
    results.find((r) => r.id === 'behavioral/golden');

  it('FAILS when the golden file is missing (never created implicitly)', async () => {
    const result = golden(await runBehavioralChecks({ connection, suites, golden: { baseDir, update: false } }));
    expect(result?.status).toBe('fail');
    expect(result?.message).toContain('--update-golden');
    await expect(readFile(join(baseDir, 'golden', 'echo.json'), 'utf-8')).rejects.toThrow();
  });

  it('--update-golden writes the file, then a normal run passes against it', async () => {
    const written = golden(await runBehavioralChecks({ connection, suites, golden: { baseDir, update: true } }));
    expect(written?.status).toBe('pass');

    const file = JSON.parse(await readFile(join(baseDir, 'golden', 'echo.json'), 'utf-8')) as {
      isError: boolean;
    };
    expect(file.isError).toBe(false);

    const compared = golden(await runBehavioralChecks({ connection, suites, golden: { baseDir, update: false } }));
    expect(compared?.status).toBe('pass');
  });

  it('FAILS on a changed output and reports expected vs actual', async () => {
    await runBehavioralChecks({ connection, suites, golden: { baseDir, update: true } });
    const path = join(baseDir, 'golden', 'echo.json');
    const tampered = (await readFile(path, 'utf-8')).replace('hello', 'goodbye');
    await writeFile(path, tampered);

    const result = golden(await runBehavioralChecks({ connection, suites, golden: { baseDir, update: false } }));
    expect(result?.status).toBe('fail');
    expect(JSON.stringify(result?.expected)).toContain('goodbye');
    expect(JSON.stringify(result?.actual)).toContain('hello');
  });

  it('ignores key order in the golden file', async () => {
    await runBehavioralChecks({ connection, suites, golden: { baseDir, update: true } });
    const path = join(baseDir, 'golden', 'echo.json');
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(parsed).reverse());
    await writeFile(path, JSON.stringify(reordered));

    const result = golden(await runBehavioralChecks({ connection, suites, golden: { baseDir, update: false } }));
    expect(result?.status).toBe('pass');
  });

  it('FAILS on a golden file that is not JSON', async () => {
    await runBehavioralChecks({ connection, suites, golden: { baseDir, update: true } });
    await writeFile(join(baseDir, 'golden', 'echo.json'), 'not json');
    const result = golden(await runBehavioralChecks({ connection, suites, golden: { baseDir, update: false } }));
    expect(result?.status).toBe('fail');
    expect(result?.message).toContain('not valid JSON');
  });
});
