/**
 * A stdio server must never outlive mcpward (#71), even one that ignores stdin EOF and
 * SIGTERM, and even when it runs behind a wrapper (`npx tsx ...`) that is the actual child.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../../src/client/connect.js';
import { testConfig } from '../helpers/config.js';

const STUBBORN = join(process.cwd(), 'fixtures', 'stubborn-server', 'index.ts');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

describe('stdio server process cleanup (#71)', () => {
  const dirs: string[] = [];
  const pids: number[] = [];

  afterEach(() => {
    // Never leak a stubborn process from a failing test
    for (const pid of pids.splice(0)) {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function stubbornConfig(
    mode: 'silent' | 'reject' | 'spawn-on-eof' | 'normal',
    connectMs: number
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'mcpward-stubborn-'));
    dirs.push(dir);
    const pidFile = join(dir, 'pid');
    const workerPidFile = join(dir, 'worker-pid');
    const config = testConfig({
      server: {
        transport: 'stdio',
        command: 'npx',
        args: ['tsx', STUBBORN],
        env: {
          STUBBORN_PID_FILE: pidFile,
          STUBBORN_WORKER_PID_FILE: workerPidFile,
          STUBBORN_MODE: mode,
        },
      },
      timeouts: { connect_ms: connectMs, call_ms: 2000, run_ms: 30000 },
    });
    return { config, pidFile, workerPidFile };
  }

  async function serverPid(pidFile: string): Promise<number> {
    expect(await waitFor(() => existsSync(pidFile), 20000)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    pids.push(pid);
    return pid;
  }

  it('kills the server when the connect timeout fires', async () => {
    const { config, pidFile } = stubbornConfig('silent', 8000);
    const connecting = connect(config);
    const pid = await serverPid(pidFile);
    await expect(connecting).rejects.toThrow(/Timeout.*connection to server/);
    expect(await waitFor(() => !isAlive(pid), 2000)).toBe(true);
  }, 40000);

  it('kills a wrapped server that ignores stdin EOF and SIGTERM on close', async () => {
    const { config, pidFile } = stubbornConfig('normal', 20000);
    const connection = await connect(config);
    const pid = await serverPid(pidFile);
    expect(isAlive(pid)).toBe(true);
    await connection.close();
    expect(await waitFor(() => !isAlive(pid), 2000)).toBe(true);
  }, 40000);

  it('kills the server when the SDK closes the transport itself (initialize error)', async () => {
    // The SDK closes the transport BEFORE connect() rejects, which clears transport.pid:
    // cleanup must run on that close, not only on mcpward's own
    const { config, pidFile } = stubbornConfig('reject', 20000);
    const connecting = connect(config);
    const pid = await serverPid(pidFile);
    await expect(connecting).rejects.toThrow(/initialize rejected by fixture/);
    expect(await waitFor(() => !isAlive(pid), 2000)).toBe(true);
  }, 40000);

  it('kills a child the server starts while it is being closed', async () => {
    const { config, pidFile, workerPidFile } = stubbornConfig('spawn-on-eof', 20000);
    const connection = await connect(config);
    const pid = await serverPid(pidFile);
    await connection.close();
    const workerPid = await serverPid(workerPidFile);
    expect(await waitFor(() => !isAlive(pid) && !isAlive(workerPid), 2000)).toBe(true);
  }, 40000);
});
