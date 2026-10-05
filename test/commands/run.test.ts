/**
 * `mcpward run` end-to-end behavior (M6).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'path';
import { runCommand } from '../../src/commands/run.js';
import { withRunDeadline, RunDeadlineError, closeOnce } from '../../src/commands/output.js';
import type { McpConnection } from '../../src/client/connect.js';
import { testConfig } from '../helpers/config.js';

const FIXTURES = join(process.cwd(), 'fixtures');

function silenceConsole() {
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  return errors;
}

describe('timeouts.run_ms (M6.1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('ends a run against a hanging server at run_ms with exit 2', async () => {
    const errors = silenceConsole();
    const config = testConfig({
      server: {
        transport: 'stdio',
        command: 'npx',
        args: ['tsx', join(FIXTURES, 'hanging-server', 'index.ts')],
      },
      // call_ms far above run_ms: only the whole-run deadline can end this run
      timeouts: { connect_ms: 20000, call_ms: 120000, run_ms: 1500 },
      suites: [{ tool: 'hang_forever', cases: [{ name: 'never answers', args: {} }] }],
    });

    const started = Date.now();
    const code = await runCommand(config, { config: 'mcpward.yaml', reporter: 'json' });
    const elapsed = Date.now() - started;

    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('run_ms');
    // Connection setup is excluded from run_ms; the checks themselves must stop near 1.5s
    expect(elapsed).toBeLessThan(30000);
  }, 60000);

  it('does not interfere with a run that finishes in time', async () => {
    silenceConsole();
    const config = testConfig({
      server: {
        transport: 'stdio',
        command: 'npx',
        args: ['tsx', join(FIXTURES, 'good-server', 'index.ts')],
      },
      timeouts: { run_ms: 60000 },
    });
    expect(await runCommand(config, { config: 'mcpward.yaml', reporter: 'json' })).toBe(0);
  }, 60000);
});

describe('withRunDeadline', () => {
  it('rejects with RunDeadlineError BEFORE running onExpire', async () => {
    const order: string[] = [];
    const never = new Promise<string>(() => undefined);
    await expect(
      withRunDeadline(never, 20, async () => {
        order.push('expire');
      })
    ).rejects.toBeInstanceOf(RunDeadlineError);
    order.push('rejected');
    await new Promise((r) => setTimeout(r, 10));
    // Even if closing the connection makes the work settle, the deadline already won the race
    expect(order[0]).toBe('expire');
  });

  it('a result that wins the race is returned untouched', async () => {
    await expect(withRunDeadline(Promise.resolve(42), 1000, async () => undefined)).resolves.toBe(
      42
    );
  });

  it('work that settles because the connection was closed does not count as a result', async () => {
    let settle: (v: string) => void = () => undefined;
    const work = new Promise<string>((r) => {
      settle = r;
    });
    await expect(
      withRunDeadline(work, 20, async () => {
        settle('fake success after close');
      })
    ).rejects.toBeInstanceOf(RunDeadlineError);
  });
});

describe('closeOnce', () => {
  it('closes once and makes every caller wait for that same shutdown', async () => {
    let calls = 0;
    let finish: () => void = () => undefined;
    const connection = {
      close: () => {
        calls += 1;
        return new Promise<void>((r) => {
          finish = r;
        });
      },
    } as unknown as McpConnection;

    const close = closeOnce(connection);
    const first = close(); // e.g. the run deadline
    let secondDone = false;
    const second = close().then(() => {
      secondDone = true; // e.g. command cleanup before process.exit
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    expect(secondDone).toBe(false); // cleanup is still waiting for the server to exit

    finish();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
  });

  it('does not swallow close errors — callers decide (baseline reports them)', async () => {
    const connection = {
      close: () => Promise.reject(new Error('kill failed')),
    } as unknown as McpConnection;
    const close = closeOnce(connection);
    await expect(close()).rejects.toThrow('kill failed');
    await expect(close()).rejects.toThrow('kill failed'); // same memoized outcome
  });
});
