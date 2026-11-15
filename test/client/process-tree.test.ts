/**
 * Pure process-tree logic behind stdio cleanup (#71). Killing the wrong process is worse than
 * leaving one behind, so identity (pid + start time) and the stale-parent rule are tested
 * explicitly.
 */

import { describe, it, expect } from 'vitest';
import {
  descendantsOf,
  isSpawnedRoot,
  parseProcStat,
  parseProcessTable,
  sameProcess,
  survivorsOf,
  trackDescendants,
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

  it('parses Windows output (filetime → Unix ms, comparable with Date.now) and CRLF', () => {
    // 2026-11-15T00:00:00Z as a FILETIME, and 100 ms later
    const at = Date.UTC(2026, 10, 15);
    const filetime = (ms: number) => String((ms + 11_644_473_600_000) * 10_000);
    const text = `4 0 ${filetime(at)}\r\n812 4 ${filetime(at + 100)}\r\n`;
    expect(parseProcessTable(text, 'windows')).toEqual([
      { pid: 4, ppid: 0, started: at },
      { pid: 812, ppid: 4, started: at + 100 },
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

  it('never matches when the start time was never known, even against itself', () => {
    // undefined === undefined must not count as identity
    expect(sameProcess({ pid: 10, ppid: 1 }, { pid: 10, ppid: 1 })).toBe(false);
  });
});

describe('isSpawnedRoot', () => {
  const window = { from: 10_000, to: 10_200 };

  it.each([
    ['started inside the spawn window', 10_100, true],
    ['started up to the slack before it (lstart rounds down to the second)', 8_600, true],
    ['started just after it', 11_000, true],
    ['started long after: a later process reused the pid', 60_000, false],
    ['started long before', 1_000, false],
  ])('%s → %s', (_name, started, expected) => {
    expect(isSpawnedRoot({ pid: 10, ppid: 1, started }, window)).toBe(expected);
  });

  it('rejects a root without a start time or not found', () => {
    expect(isSpawnedRoot({ pid: 10, ppid: 1 }, window)).toBe(false);
    expect(isSpawnedRoot(undefined, window)).toBe(false);
  });
});

describe('parseProcStat', () => {
  // Fields after comm: state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt
  // cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime ...
  const rest = 'S 4321 1 1 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 12345 1000 10';

  it('reads pid, ppid and the start time (ticks → ms since boot time)', () => {
    expect(parseProcStat(`420 (node) ${rest}`, 1_000_000, 100)).toEqual({
      pid: 420,
      ppid: 4321,
      started: 1_000_000 + 123_450,
    });
  });

  it('handles a comm with spaces and parentheses', () => {
    expect(parseProcStat(`420 (my (odd) name) ${rest}`, 0, 100)).toEqual({
      pid: 420,
      ppid: 4321,
      started: 123_450,
    });
  });

  it('rejects malformed lines', () => {
    expect(parseProcStat('garbage', 0, 100)).toBeUndefined();
    expect(parseProcStat('420 (node) S', 0, 100)).toBeUndefined();
  });
});

describe('descendantsOf', () => {
  it('returns children and grandchildren, parents first', () => {
    const table = [
      { pid: 10, ppid: 1, started: 100 }, // the wrapper (npx)
      { pid: 11, ppid: 10, started: 110 }, // tsx
      { pid: 12, ppid: 11, started: 120 }, // the server
      { pid: 13, ppid: 10, started: 130 },
      { pid: 20, ppid: 1, started: 140 }, // unrelated sibling
    ];
    expect(pids(descendantsOf([10], table))).toEqual([11, 13, 12]);
  });

  it('never includes the roots or unrelated processes', () => {
    const table = [
      { pid: 10, ppid: 1, started: 100 },
      { pid: 20, ppid: 1, started: 100 },
      { pid: 21, ppid: 20, started: 200 },
    ];
    expect(descendantsOf([10], table)).toEqual([]);
  });

  it('returns nothing for a root that is not in the table', () => {
    expect(descendantsOf([99], [{ pid: 11, ppid: 99, started: 100 }])).toEqual([]);
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

  it('never follows a link where either start time is unknown', () => {
    // 30 has no start time: it may be an unrelated process with a stale parent id, so
    // neither it nor its child 31 is followed
    const table = [
      { pid: 10, ppid: 1, started: 500 },
      { pid: 30, ppid: 10 },
      { pid: 31, ppid: 30, started: 700 },
      { pid: 11, ppid: 10, started: 600 },
    ];
    expect(pids(descendantsOf([10], table))).toEqual([11]);
    // ...nor from a root whose start time is unknown
    expect(descendantsOf([30], table)).toEqual([]);
  });

  it('terminates on a cycle', () => {
    const table = [
      { pid: 10, ppid: 11, started: 100 },
      { pid: 11, ppid: 10, started: 100 },
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

  it('never adds a new process whose start time is unknown', () => {
    const table = [
      { pid: 12, ppid: 1, started: 500 },
      { pid: 40, ppid: 12 }, // no identity to re-check before signalling
      { pid: 41, ppid: 12, started: 800 },
    ];
    expect(pids(survivorsOf([server], table))).toEqual([12, 41]);
  });

  it('never adds children of a reused pid', () => {
    const table = [
      { pid: 12, ppid: 1, started: 900 }, // not our server
      { pid: 40, ppid: 12, started: 950 },
    ];
    expect(survivorsOf([server], table)).toEqual([]);
  });
});

describe('trackDescendants', () => {
  const root = { pid: 10, ppid: 1, started: 100 };

  it('tracks the live descendants of the root, not the root itself', () => {
    const table = [root, { pid: 11, ppid: 10, started: 200 }];
    expect(trackDescendants(root, [], table)).toEqual([{ pid: 11, ppid: 10, started: 200 }]);
  });

  it('keeps a tracked process that has exited (it is filtered when signalling)', () => {
    const child = { pid: 11, ppid: 10, started: 200 };
    expect(trackDescendants(root, [child], [root])).toEqual([child]);
  });

  it('tracks a new child that reused the pid of an exited tracked child', () => {
    const exited = { pid: 11, ppid: 10, started: 200 };
    const reused = { pid: 11, ppid: 10, started: 900 };
    expect(trackDescendants(root, [exited], [root, reused])).toEqual([exited, reused]);
  });

  it('does not add the same process twice', () => {
    const child = { pid: 11, ppid: 10, started: 200 };
    expect(trackDescendants(root, [child], [root, child])).toEqual([child]);
  });

  it('tracks nothing new once the root pid belongs to another process', () => {
    const table = [
      { pid: 10, ppid: 1, started: 5000 },
      { pid: 12, ppid: 10, started: 6000 },
    ];
    expect(trackDescendants(root, [], table)).toEqual([]);
  });
});
