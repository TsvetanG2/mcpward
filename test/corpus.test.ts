/**
 * Security detector corpora.
 *
 * - `test/corpus/evasion/`: hostile tools rewritten to dodge the detectors (homoglyphs, split
 *   words, invisible characters, encodings, markdown, other languages, unusual placement), plus
 *   benign near-misses. Each case says whether it SHOULD be flagged.
 * - `test/corpus/registry-clean/`: real tool definitions; none should be flagged. Entries that
 *   are flagged today are listed in its `known-false-positives.json`.
 *
 * A case the detectors get wrong today carries `knownGap` (evasion) or a known-false-positives
 * entry (registry) and runs as `it.fails`: the suite stays green, the gap stays visible, and a
 * detector that closes the gap turns the test red until the note is removed.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { checkToolSecurity } from '../src/checks/security.js';
import type { Tool } from '../src/checks/schema.js';

const CORPUS = join(process.cwd(), 'test', 'corpus');

interface EvasionCase {
  category: string;
  technique: string;
  shouldFlag: boolean;
  knownGap?: string;
  tool: Tool;
}

function jsonFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    : [];
}

/** Ids of the failing security results for one tool. */
function findings(tool: Tool): string[] {
  return checkToolSecurity(tool)
    .filter((r) => r.status === 'fail')
    .map((r) => r.id);
}

describe('evasion corpus', () => {
  const dir = join(CORPUS, 'evasion');
  const files = jsonFiles(dir);

  it('has cases', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const c = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as EvasionCase;
    const name = `${file}: ${c.technique} — ${c.shouldFlag ? 'flagged' : 'not flagged'}`;
    const run = () => {
      const ids = findings(c.tool);
      if (c.shouldFlag) expect(ids).not.toEqual([]);
      else expect(ids).toEqual([]);
    };
    if (c.knownGap) it.fails(`${name} [known gap: ${c.knownGap}]`, run);
    else it(name, run);
  }
});

interface RegistryEntry {
  server: string;
  version: string;
  tool: Tool;
}

interface KnownFalsePositive {
  server: string;
  tool: string;
  ids: string[];
  reason: string;
}

describe('registry clean corpus', () => {
  const dir = join(CORPUS, 'registry-clean');
  const known: KnownFalsePositive[] = existsSync(join(dir, 'known-false-positives.json'))
    ? (JSON.parse(
        readFileSync(join(dir, 'known-false-positives.json'), 'utf-8')
      ) as KnownFalsePositive[])
    : [];

  const snapshots = jsonFiles(dir).filter((f) => f !== 'known-false-positives.json');
  if (snapshots.length === 0) it.todo('snapshot of registry tool definitions');

  for (const file of snapshots) {
    const entries = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as RegistryEntry[];
    for (const { server, version, tool } of entries) {
      const fp = known.find((k) => k.server === server && k.tool === tool.name);
      const name = `${server}@${version} ${tool.name}`;
      if (fp) {
        // A known false positive: asserted exactly, so a change in either direction is seen
        it(`${name} [known false positive: ${fp.reason}]`, () => {
          expect([...new Set(findings(tool))].sort()).toEqual([...fp.ids].sort());
        });
      } else {
        it(`${name} — no finding`, () => {
          expect(findings(tool)).toEqual([]);
        });
      }
    }
  }
});
