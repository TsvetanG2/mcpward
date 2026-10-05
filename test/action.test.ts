/**
 * GitHub Action definition (M8).
 *
 * The root action.yml is canonical (`uses: TsvetanG2/mcpward@<tag>`, Marketplace).
 * action/action.yml is kept so existing `uses: TsvetanG2/mcpward/action@...` keeps working;
 * the two must never diverge. Inputs/outputs are public contract (docs/stability.md).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/** The action's run step is bash; skip the script test where bash is not installed. */
function hasBash(): boolean {
  return spawnSync('bash', ['-c', 'exit 0']).status === 0;
}

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8').split('\r\n').join('\n');

interface ActionYaml {
  inputs: Record<string, { default?: string }>;
  outputs: Record<string, unknown>;
  runs: { using: string };
}

describe('GitHub Action definition', () => {
  it('root action.yml and action/action.yml are identical', () => {
    expect(read('action/action.yml')).toBe(read('action.yml'));
  });

  it('keeps the contract inputs and outputs', () => {
    const action = parseYaml(read('action.yml')) as ActionYaml;
    expect(Object.keys(action.inputs)).toEqual(
      expect.arrayContaining([
        'config',
        'reporter',
        'output',
        'version',
        'local',
        'working-directory',
        'pr-comment',
        'github-token',
      ])
    );
    expect(Object.keys(action.outputs).sort()).toEqual(['exit-code', 'report-path']);
    expect(action.runs.using).toBe('composite');
  });

  it.runIf(hasBash())('fails the step on EVERY non-zero exit code, not only 1 and 2', () => {
    const action = parseYaml(read('action.yml')) as {
      runs: { steps: { id?: string; run?: string }[] };
    };
    const script = action.runs.steps.find((s) => s.id === 'run')?.run;
    if (!script) throw new Error('run step not found in action.yml');

    // A fake local build whose CLI exits with FAKE_EXIT
    const dir = mkdtempSync(join(tmpdir(), 'mcpward-action-'));
    try {
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'dist', 'cli.js'), 'process.exit(Number(process.env.FAKE_EXIT));');
      writeFileSync(join(dir, 'step.sh'), script);

      const run = (exit: number) => {
        const out = join(dir, `out-${exit}`);
        writeFileSync(out, '');
        const r = spawnSync('bash', ['step.sh'], {
          cwd: dir,
          encoding: 'utf-8',
          env: {
            ...process.env,
            FAKE_EXIT: String(exit),
            IN_LOCAL: 'true',
            IN_CONFIG: 'mcpward.yaml',
            IN_REPORTER: 'console',
            IN_OUTPUT: '',
            IN_PR_COMMENT: 'false',
            GITHUB_OUTPUT: out,
          },
        });
        return { status: r.status, output: readFileSync(out, 'utf-8') };
      };

      expect(run(0).status).toBe(0);
      expect(run(1).status).toBe(1);
      expect(run(2).status).toBe(2);
      // interrupted (SIGINT) / killed / anything else must not be a green step
      const interrupted = run(130);
      expect(interrupted.status).toBe(130);
      expect(interrupted.output).toContain('exit-code=130');
      expect(run(137).status).toBe(137);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to the version being released (never a stale one)', () => {
    const action = parseYaml(read('action.yml')) as ActionYaml;
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(action.inputs.version?.default).toBe(pkg.version);
  });
});
