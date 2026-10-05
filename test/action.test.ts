/**
 * GitHub Action definition (M8).
 *
 * The root action.yml is canonical (`uses: TsvetanG2/mcpward@<tag>`, Marketplace).
 * action/action.yml is kept so existing `uses: TsvetanG2/mcpward/action@...` keeps working;
 * the two must never diverge. Inputs/outputs are public contract (docs/stability.md).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

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

  it('defaults to the version being released (never a stale one)', () => {
    const action = parseYaml(read('action.yml')) as ActionYaml;
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(action.inputs.version?.default).toBe(pkg.version);
  });
});
