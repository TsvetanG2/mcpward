/**
 * Word diff + description rendering tests (M2.4).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { wordDiff, markInvisibleCharacters } from '../../src/report/text-diff.js';
import { renderConsoleReport } from '../../src/report/console.js';
import type { CheckReport, CheckResult } from '../../src/report/model.js';

describe('wordDiff', () => {
  it('marks only the changed words', () => {
    expect(wordDiff('Echoes the message.', 'Echoes and logs the message.')).toEqual([
      { kind: 'same', text: 'Echoes ' },
      { kind: 'added', text: 'and logs ' },
      { kind: 'same', text: 'the message.' },
    ]);
  });

  it('reconstructs both sides exactly', () => {
    const a = 'Reads a file.\nNever writes.';
    const b = 'Reads a file.\nMay write  to disk.';
    const segs = wordDiff(a, b) ?? [];
    expect(
      segs
        .filter((s) => s.kind !== 'added')
        .map((s) => s.text)
        .join('')
    ).toBe(a);
    expect(
      segs
        .filter((s) => s.kind !== 'removed')
        .map((s) => s.text)
        .join('')
    ).toBe(b);
  });

  it('refuses to diff hostile-size input instead of allocating O(n·m)', () => {
    const huge = 'w '.repeat(5000);
    expect(wordDiff(huge, huge + 'x')).toBeNull();
  });
});

describe('markInvisibleCharacters', () => {
  it('makes Unicode Tag (ASCII smuggling) characters visible', () => {
    expect(markInvisibleCharacters('ok\u{E0068}\u{E0069}')).toBe('ok<U+E0068><U+E0069>');
  });

  it('makes zero-width, bidi and soft-hyphen characters visible', () => {
    expect(markInvisibleCharacters('a\u200Bb\u202Ec\u2066d\u00ADe')).toBe(
      'a<U+200B>b<U+202E>c<U+2066>d<U+00AD>e'
    );
  });
});

describe('console description_changed rendering', () => {
  afterEach(() => vi.restoreAllMocks());

  function render(result: Partial<CheckResult>): string {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    const full: CheckResult = {
      id: 'drift/description_changed',
      family: 'drift',
      status: 'fail',
      severity: 'error',
      message: 'Tool "echo" description changed (possible rug-pull)',
      location: 'echo',
      ...result,
    };
    const report: CheckReport = {
      schemaVersion: 1,
      version: '0.0.0',
      timestamp: 't',
      server: { name: 's', version: '1', protocolVersion: 'p' },
      summary: { total: 1, passed: 0, failed: 1, warnings: 0, skipped: 0 },
      results: [full],
    };
    renderConsoleReport(report);
    // Strip ANSI so assertions hold with or without colour support
    // eslint-disable-next-line no-control-regex
    return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  }

  it('renders a word diff for SHORT descriptions (regression: <64 chars was skipped)', () => {
    const out = render({ expected: 'Echoes the message.', actual: 'Echoes and logs the message.' });
    expect(out).toContain('description diff:');
    expect(out).toContain('Echoes {+and logs +}the message.');
  });

  it('shows an injected zero-width character explicitly', () => {
    const out = render({ expected: 'Reads a file.', actual: 'Reads a\u200B file.' });
    expect(out).toContain('<U+200B>');
  });

  it('explains when only hashes are available', () => {
    const hash = (c: string) => `sha256:${c.repeat(64)}`;
    const out = render({ expected: hash('a'), actual: hash('b') });
    expect(out).toContain('full text unavailable');
    expect(out).not.toContain('description diff:');
  });

  it('falls back to before/after with an explicit truncation marker for long text', () => {
    const long = 'x'.repeat(300);
    const out = render({ expected: long, actual: long + ' y' });
    expect(out).toContain('previous description:');
    expect(out).toContain('truncated, see JSON report');
  });
});
