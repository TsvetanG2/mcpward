/**
 * CHANGELOG consistency tests.
 *
 * The link references at the bottom of CHANGELOG.md stopped at 0.2.1 for 19 releases.
 * These tests make a release fail until its heading and link reference are added.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = 'https://github.com/TsvetanG2/mcpward';

const changelog = readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf-8');
const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
  version: string;
};

const headings = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1] ?? '');
const versions = headings.filter((h) => h !== 'Unreleased');
const refs = new Map(
  [...changelog.matchAll(/^\[([^\]]+)\]: (\S+)$/gm)].map((m) => [m[1] ?? '', m[2] ?? ''])
);

describe('CHANGELOG', () => {
  test('newest release heading matches package.json', () => {
    expect(versions[0]).toBe(packageJson.version);
  });

  test('every heading has a link reference', () => {
    const missing = headings.filter((h) => !refs.has(h));
    expect(missing).toEqual([]);
  });

  test('every link reference belongs to a heading', () => {
    const orphans = [...refs.keys()].filter((r) => r !== 'Unreleased' && !headings.includes(r));
    expect(orphans).toEqual([]);
  });

  test('newest release compares the previous tag with its own tag', () => {
    const [latest, previous] = versions;
    expect(refs.get(latest ?? '')).toBe(`${REPO}/compare/v${previous}...v${latest}`);
  });

  test('Unreleased compares the newest release tag with HEAD', () => {
    expect(refs.get('Unreleased')).toBe(`${REPO}/compare/v${versions[0]}...HEAD`);
  });
});
