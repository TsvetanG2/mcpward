/**
 * Pure process-tree logic behind stdio cleanup (#71). Killing the wrong process is worse than
 * leaving one behind, so identity (pid + start time) and the stale-parent rule are tested
 * explicitly.
 */

import { describe, it, expect } from 'vitest';
import {
  descendantsOf,
  parseProcessTable,
  sameProcess,
  survivorsOf,
} from '../../src/client/process-tree.js';

const pids = (entries: { pid: number }[]) => entries.map((entry) => entry.pid);

describe('parseProcessTable', () => {
  it('parses ps output with lstart (pid ppid lstart)', () => {
    const text = '    1     0 Sun Nov  5 03:55:53 2026\n  420     1 Sun Nov 15 03:55:54 2026\n';
    expect(parseProcessTable(text, 'posix')).toEqual([
      { pid: 1, ppid: 0, started: Date.parse('Sun Nov 5 03:55:53 2026') },
      { pid: 420, ppid: 1, started: Date.parse('Sun Nov 15 03:55:54 2026') },
    ]);
  });

  it('parses Windows output (filetime ticks → ms) and CRLF', () => {
    expect(parseProcessTable('4 0 1000000\r\n812 4 2000000\r\n', 'windows')).toEqual([
      { pid: 4, ppid: 0, started: 100 },
      { pid: 812, ppid: 4, started: 200 },
    ]);
  });

  it('keeps a process whose start time cannot be read, without one', () => {
    expect(parseProcessTable('9 3 garbage', 'posix')).toEqual([{ pid: 9, ppid: 3 }]);
  });

  it('skips blank and malformed lines', () => {
    expect(parseProcessTable('\nPID PPID\n7\n9 3\n', 'windows')).toEqual([{ pid: 9, ppid: 3 }]);
  });
});

describe('sameProcess', () => {
  const known = { pid: 10, ppid: 1, started: 500 };

  it.each([
    ['same pid and start time', { pid: 10, ppid: 1, started: 500 }, true],
    ['same pid, reparented (ppid changed)', { pid: 10, ppid: 1234, started: 500 }, true],
    ['pid reused by a newer process', { pid: 10, ppid: 1, started: 900 }, false],
    ['start time no longer readable', { pid: 10, ppid: 1 }, false],
    ['different pid', { pid: 11, ppid: 1, started: 500 }, false],
    ['gone', undefined, false],
  ])('%s → %s', (_name, entry, expected) => {
    expect(sameProcess(known, entry)).toBe(expected);
  });
});

describe('descendantsOf', () => {
  it('returns children and grandchildren, parents first', () => {
    const table = [
      { pid: 10, ppid: 1 }, // the wrapper (npx)
      { pid: 11, ppid: 10 }, // tsx
      { pid: 12, ppid: 11 }, // the server
      { pid: 13, ppid: 10 },
      { pid: 20, ppid: 1 }, // unrelated sibling
    ];
    expect(pids(descendantsOf([10], table))).toEqual([11, 13, 12]);
  });

  it('never includes the roots or unrelated processes', () => {
    const table = [
      { pid: 10, ppid: 1 },
      { pid: 20, ppid: 1 },
      { pid: 21, ppid: 20 },
    ];
    expect(descendantsOf([10], table)).toEqual([]);
  });

  it('returns nothing for a root that is not in the table', () => {
    expect(descendantsOf([99], [{ pid: 11, ppid: 99 }])).toEqual([]);
  });

  it('does not follow a stale parent id (child older than its parent)', () => {
    // On Windows, 30 kept the id of a parent that exited; 10 later reused that id
    const table = [
      { pid: 10, ppid: 1, started: 500 },
      { pid: 11, ppid: 10, started: 600 },
      { pid: 30, ppid: 10, started: 100 },
      { pid: 31, ppid: 30, started: 700 },
    ];
    expect(pids(descendantsOf([10], table))).toEqual([11]);
  });

  it('terminates on a cycle', () => {
    const table = [
      { pid: 10, ppid: 11 },
      { pid: 11, ppid: 10 },
    ];
    expect(pids(descendantsOf([10], table))).toEqual([11]);
  });
});

describe('survivorsOf', () => {
  const server = { pid: 12, ppid: 11, started: 500 };

  it('keeps a tracked process that is still the same process', () => {
    // Reparented (ppid 11 → 1), still the same process
    expect(survivorsOf([server], [{ pid: 12, ppid: 1, started: 500 }])).toEqual([server]);
  });

  it('drops a tracked pid now used by another process', () => {
    expect(survivorsOf([server], [{ pid: 12, ppid: 1, started: 900 }])).toEqual([]);
  });

  it('drops a tracked process that is gone', () => {
    expect(survivorsOf([server], [{ pid: 1, ppid: 0, started: 1 }])).toEqual([]);
  });

  it('adds what a surviving process started since it was tracked', () => {
    const table = [
      { pid: 12, ppid: 1, started: 500 },
      { pid: 40, ppid: 12, started: 800 }, // worker started during shutdown
      { pid: 41, ppid: 40, started: 810 },
    ];
    expect(pids(survivorsOf([server], table))).toEqual([12, 40, 41]);
  });

  it('never adds children of a reused pid', () => {
    const table = [
      { pid: 12, ppid: 1, started: 900 }, // not our server
      { pid: 40, ppid: 12, started: 950 },
    ];
    expect(survivorsOf([server], table)).toEqual([]);
  });
});
