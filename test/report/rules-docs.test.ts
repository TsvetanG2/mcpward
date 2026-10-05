/**
 * Every check id mcpward can emit must have a section in docs/rules.md.
 *
 * SARIF helpUri links point at `docs/rules.md#<anchor>`; an id without a heading is a dead
 * link in GitHub code scanning. Ids are harvested from the source, so a new check cannot
 * ship undocumented.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { toHelpAnchor } from '../../src/report/sarif.js';
import { DRIFT_CLASSES } from '../../src/config/schema.js';

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** GitHub heading slug (github-slugger): lowercase, drop punctuation except - and _. */
function slug(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

describe('docs/rules.md coverage', () => {
  const anchors = new Set(
    Array.from(
      readFileSync(join(ROOT, 'docs', 'rules.md'), 'utf-8').matchAll(/^#{2,3}\s+(.+)$/gm),
      (m) => slug(m[1] ?? '')
    )
  );

  const emitted = new Set<string>();
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    for (const m of readFileSync(file, 'utf-8').matchAll(/id: '([a-z]+\/[a-z_-]+)'/g)) {
      if (m[1]) emitted.add(m[1]);
    }
  }
  // drift/${change.class} — one id per drift class
  for (const cls of DRIFT_CLASSES) emitted.add(`drift/${cls}`);

  it('harvests a plausible number of ids (guards the harvester itself)', () => {
    expect(emitted.size).toBeGreaterThan(40);
    expect(emitted.has('collision/description-collision')).toBe(true);
    expect(emitted.has('drift/breaking_output_shape_change')).toBe(true);
    expect(emitted.has('security/hidden-unicode')).toBe(true);
  });

  it('documents every emitted id', () => {
    const missing = [...emitted].filter((id) => !anchors.has(toHelpAnchor(id))).sort();
    expect(missing).toEqual([]);
  });
});
