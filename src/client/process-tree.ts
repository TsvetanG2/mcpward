import { execFile } from 'node:child_process';

/**
 * Process-tree cleanup for stdio servers (#71).
 *
 * The SDK's stdio transport stops only the process it spawned. A server launched through a
 * wrapper (`npx`, `tsx`, `uvx`, `sh -c`, `cmd /c` on Windows) is a grandchild: when it
 * ignores stdin EOF and SIGTERM, killing the wrapper leaves it running after mcpward exits.
 *
 * So the tree is tracked from BEFORE the transport closes (once a parent dies on POSIX, its
 * children are reparented and can no longer be traced) until every tracked process is gone,
 * and processes that appear while the server shuts down are picked up on the way.
 *
 * Killing an unrelated process is worse than leaving one behind. A process is identified by
 * its pid AND its start time, and that identity is re-checked before every signal: a pid can
 * be reused as soon as its process exits. When the process table cannot be read, nothing is
 * signalled and cleanup is what the SDK does on its own.
 */

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Start time in ms; with the pid, this identifies the process. */
  started?: number;
}

export type TableFormat = 'posix' | 'windows';

/** How long a listing may take before cleanup goes ahead without it. */
const LIST_TIMEOUT_MS = 5000;

/** How often the tree is re-read while the transport is closing. */
const TRACK_INTERVAL_MS = 250;

/** How long survivors get after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2000;

/** Bounds the kill loop: each round catches processes started by the previous survivors. */
const MAX_KILL_ROUNDS = 3;

/**
 * Parses a process listing. Pure; malformed lines are skipped.
 *
 * - posix: `pid ppid lstart` (`ps -o pid=,ppid=,lstart=`, lstart like `Sun Nov  5 03:55:53 2026`)
 * - windows: `pid ppid filetime` (100 ns ticks since 1601, UTC)
 */
export function parseProcessTable(text: string, format: TableFormat): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pidText, ppidText, ...rest] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!pidText || !ppidText || !Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const started =
      format === 'windows' ? Math.floor(Number(rest[0]) / 10_000) : Date.parse(rest.join(' '));
    entries.push(Number.isFinite(started) ? { pid, ppid, started } : { pid, ppid });
  }
  return entries;
}

/** True when `entry` is the same process as `known`: same pid, same start time. Pure. */
export function sameProcess(known: ProcessEntry, entry: ProcessEntry | undefined): boolean {
  return entry !== undefined && entry.pid === known.pid && entry.started === known.started;
}

/**
 * Every descendant of the `roots` in the table, parents before children. Pure.
 *
 * On Windows a parent id is not kept current: a process keeps the id of a parent that has
 * exited, and that id can be reused. A "child" that started before its supposed parent is
 * such a stale link and is never followed.
 */
export function descendantsOf(roots: number[], table: ProcessEntry[]): ProcessEntry[] {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const result: ProcessEntry[] = [];
  const seen = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const parent = byPid.get(queue.shift() as number);
    if (parent === undefined) continue;
    for (const entry of table) {
      if (seen.has(entry.pid) || entry.ppid !== parent.pid) continue;
      if (
        parent.started !== undefined &&
        entry.started !== undefined &&
        entry.started < parent.started
      ) {
        continue;
      }
      seen.add(entry.pid);
      result.push(entry);
      queue.push(entry.pid);
    }
  }
  return result;
}

/**
 * The tracked processes that are still running, plus anything they have started since. Pure.
 */
export function survivorsOf(tracked: ProcessEntry[], table: ProcessEntry[]): ProcessEntry[] {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const alive = tracked.filter((known) => sameProcess(known, byPid.get(known.pid)));
  const known = new Set(alive.map((entry) => entry.pid));
  const spawned = descendantsOf(
    alive.map((entry) => entry.pid),
    table
  ).filter((entry) => !known.has(entry.pid));
  return [...alive, ...spawned];
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

/**
 * Lists all processes. Best effort: an empty list means "unknown" (a real table always
 * contains mcpward itself).
 */
export async function listProcesses(): Promise<ProcessEntry[]> {
  try {
    if (process.platform === 'win32') {
      const text = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }",
      ]);
      return parseProcessTable(text, 'windows');
    }
    // LC_ALL=C: lstart must use English day and month names to be parsed
    const text = await run('ps', ['-A', '-o', 'pid=,ppid=,lstart='], {
      ...process.env,
      LC_ALL: 'C',
    });
    return parseProcessTable(text, 'posix');
  } catch {
    return [];
  }
}

function signal(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone, or not ours
    }
  }
}

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Waits until none of `pids` exists, or `ms` passes. Existence only: nothing is signalled. */
async function waitUntilGone(pids: number[], ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (pids.some(exists) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Stops tracked processes that outlived the transport, and whatever they start meanwhile:
 * SIGTERM, then SIGKILL after a grace period (both TerminateProcess on Windows). The table is
 * re-read before each signal, so only processes whose identity still matches are signalled.
 */
async function killSurvivors(tracked: ProcessEntry[]): Promise<void> {
  let current = tracked;
  for (let round = 0; round < MAX_KILL_ROUNDS && current.length > 0; round++) {
    if (!current.some((entry) => exists(entry.pid))) return;
    const table = await listProcesses();
    if (table.length === 0) return;
    const survivors = survivorsOf(current, table);
    if (survivors.length === 0) return;
    signal(
      survivors.map((entry) => entry.pid),
      'SIGTERM'
    );
    await waitUntilGone(
      survivors.map((entry) => entry.pid),
      KILL_GRACE_MS
    );
    const after = await listProcesses();
    if (after.length === 0) return;
    const stubborn = survivorsOf(survivors, after);
    signal(
      stubborn.map((entry) => entry.pid),
      'SIGKILL'
    );
    current = stubborn;
  }
}

/**
 * Closes a stdio transport and everything its process started.
 *
 * Order: read the tree, let the transport close normally (stdin EOF, then SIGTERM, then
 * SIGKILL on its own child) while re-reading the tree to pick up late children, then stop
 * any tracked process still running.
 */
export async function closeProcessTree(
  pid: number | null,
  closeTransport: () => Promise<void>
): Promise<void> {
  const initial = pid === null ? [] : await listProcesses();
  const root = initial.find((entry) => entry.pid === pid);
  const tracked = new Map<number, ProcessEntry>();
  // Follows only processes whose identity still matches: the root's pid, too, can be reused
  // once the SDK has stopped it
  const track = (table: ProcessEntry[]): void => {
    if (root === undefined) return;
    for (const entry of survivorsOf([root, ...tracked.values()], table)) {
      if (entry.pid !== root.pid && !tracked.has(entry.pid)) tracked.set(entry.pid, entry);
    }
  };
  track(initial);

  let closed = false;
  const closing = closeTransport().finally(() => {
    closed = true;
  });
  while (root !== undefined && !closed) {
    await Promise.race([closing.catch(() => undefined), delay(TRACK_INTERVAL_MS)]);
    if (!closed) track(await listProcesses());
  }
  try {
    await closing;
  } finally {
    await killSurvivors([...tracked.values()]);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
