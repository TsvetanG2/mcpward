/**
 * Security detector corpora.
 *
 * - `test/corpus/evasion/`: hostile tools rewritten to dodge the detectors (homoglyphs, split
 *   words, invisible characters, encodings, markdown, other languages, unusual placement), plus
 *   benign near-misses. Each case says whether it SHOULD be flagged.
 * - `test/corpus/registry-clean/`: real tool definitions; none should be flagged. Entries that
 *   are flagged today are listed in its `known-false-positives.json`.
 *
 * The suite stays green while every gap stays visible, and fixing a gap turns a test red until
 * its note is removed:
 * - an evasion case the detectors get wrong today carries `knownGap`, and the test asserts the
 *   wrong outcome (not `it.fails`, which would also accept a detector that throws);
 * - a registry tool flagged today is asserted against the exact rule ids in
 *   `known-false-positives.json`, so both a fix and a new finding are seen.
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
    // Not `it.fails`: that would also accept a detector that throws. A known gap asserts the
    // wrong outcome explicitly, so a crash and a fixed gap both turn the test red.
    it(c.knownGap ? `${name} [known gap: ${c.knownGap}]` : name, () => {
      const flagged = findings(c.tool).length > 0;
      expect(flagged).toBe(c.knownGap ? !c.shouldFlag : c.shouldFlag);
    });
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
  const all = snapshots.flatMap(
    (file) => JSON.parse(readFileSync(join(dir, file), 'utf-8')) as RegistryEntry[]
  );

  it('every known false positive names a tool in the snapshot', () => {
    const stale = known.filter(
      (k) => !all.some((e) => e.server === k.server && e.tool.name === k.tool)
    );
    expect(stale).toEqual([]);
  });

  for (const { server, version, tool } of all) {
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
});
