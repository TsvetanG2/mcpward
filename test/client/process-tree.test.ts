/**
 * Pure process-tree logic behind stdio cleanup (#71). Killing the wrong process is worse than
 * leaving one behind, so the stale-parent rule is tested explicitly.
 */

import { describe, it, expect } from 'vitest';
import { descendantsOf, parseProcessTable } from '../../src/client/process-tree.js';

describe('parseProcessTable', () => {
  it('parses ps output (pid ppid)', () => {
    expect(parseProcessTable('    1     0\n  420     1\n')).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 420, ppid: 1 },
    ]);
  });

  it('parses Windows output with creation times and CRLF', () => {
    expect(parseProcessTable('4 0 100\r\n812 4 200\r\n')).toEqual([
      { pid: 4, ppid: 0, started: 100 },
      { pid: 812, ppid: 4, started: 200 },
    ]);
  });

  it('skips blank and malformed lines', () => {
    expect(parseProcessTable('\nPID PPID\n7\n9 3\n')).toEqual([{ pid: 9, ppid: 3 }]);
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
    expect(descendantsOf(10, table)).toEqual([11, 13, 12]);
  });

  it('never includes the root or unrelated processes', () => {
    const table = [
      { pid: 10, ppid: 1 },
      { pid: 20, ppid: 1 },
      { pid: 21, ppid: 20 },
    ];
    expect(descendantsOf(10, table)).toEqual([]);
  });

  it('returns nothing for a root that is not in the table', () => {
    expect(descendantsOf(99, [{ pid: 11, ppid: 99 }])).toEqual([]);
  });

  it('does not follow a stale parent id (child older than its parent)', () => {
    // On Windows, 30 kept the id of a parent that exited; 10 later reused that id
    const table = [
      { pid: 10, ppid: 1, started: 500 },
      { pid: 11, ppid: 10, started: 600 },
      { pid: 30, ppid: 10, started: 100 },
      { pid: 31, ppid: 30, started: 700 },
    ];
    expect(descendantsOf(10, table)).toEqual([11]);
  });

  it('terminates on a cycle', () => {
    const table = [
      { pid: 10, ppid: 11 },
      { pid: 11, ppid: 10 },
    ];
    expect(descendantsOf(10, table)).toEqual([11]);
  });
});
