import { execFile } from 'node:child_process';

/**
 * Process-tree cleanup for stdio servers (#71).
 *
 * The SDK's stdio transport stops only the process it spawned. A server launched through a
 * wrapper (`npx`, `tsx`, `uvx`, `sh -c`, `cmd /c` on Windows) is a grandchild: when it
 * ignores stdin EOF and SIGTERM, killing the wrapper leaves it running after mcpward exits.
 *
 * So the tree is snapshotted BEFORE the transport closes (once a parent dies, its children
 * are reparented and can no longer be traced), and survivors are killed after.
 */

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Creation time (Windows only), to reject a stale parent id that was reused. */
  started?: number;
}

/** How long a listing may take before cleanup goes ahead without it. */
const LIST_TIMEOUT_MS = 5000;

/** How long survivors get after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2000;

/**
 * Parses `pid ppid [started]` lines. Pure; malformed lines are skipped.
 */
export function parseProcessTable(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, started] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined) continue;
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    entries.push(
      started !== undefined && Number.isFinite(started) ? { pid, ppid, started } : { pid, ppid }
    );
  }
  return entries;
}

/**
 * Every descendant of `root` in the table, parents before children. Pure.
 *
 * On POSIX a parent id is always current (orphans are reparented). On Windows it is not: a
 * process keeps the id of a parent that has exited, and that id can be reused. A "child"
 * created before its supposed parent is such a stale link and is never followed — following
 * it could kill an unrelated process.
 */
export function descendantsOf(root: number, table: ProcessEntry[]): number[] {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const result: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const parent = byPid.get(queue.shift() as number);
    for (const entry of table) {
      if (seen.has(entry.pid) || entry.ppid !== parent?.pid) continue;
      if (
        parent.started !== undefined &&
        entry.started !== undefined &&
        entry.started < parent.started
      ) {
        continue;
      }
      seen.add(entry.pid);
      result.push(entry.pid);
      queue.push(entry.pid);
    }
  }
  return result;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

/**
 * Lists all processes. Best effort: an empty list means "unknown", and cleanup then falls back
 * to what the SDK does on its own.
 */
export async function listProcesses(): Promise<ProcessEntry[]> {
  try {
    const text =
      process.platform === 'win32'
        ? await run('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }",
          ])
        : await run('ps', ['-A', '-o', 'pid=,ppid=']);
    return parseProcessTable(text);
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else — not ours to kill either way
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

async function waitUntilGone(pids: number[], ms: number): Promise<number[]> {
  const end = Date.now() + ms;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = alive.filter(isAlive);
  }
  return alive;
}

/**
 * Stops processes from a snapshot that outlived the transport: SIGTERM, then SIGKILL after a
 * grace period. On Windows both are TerminateProcess.
 */
export async function killSurvivors(pids: number[]): Promise<void> {
  const alive = pids.filter(isAlive);
  if (alive.length === 0) return;
  for (const pid of alive) signal(pid, 'SIGTERM');
  for (const pid of await waitUntilGone(alive, KILL_GRACE_MS)) signal(pid, 'SIGKILL');
}

/**
 * Closes a stdio transport and everything its process started.
 *
 * Order: snapshot the tree, let the transport close normally (stdin EOF, then SIGTERM, then
 * SIGKILL on its own child), then stop any descendant still running.
 */
export async function closeProcessTree(
  pid: number | null,
  closeTransport: () => Promise<void>
): Promise<void> {
  const descendants = pid === null ? [] : descendantsOf(pid, await listProcesses());
  try {
    await closeTransport();
  } finally {
    await killSurvivors(descendants);
  }
}
