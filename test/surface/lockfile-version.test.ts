/**
 * loadLockfile reads v1 (no schemaVersion) and v2 lockfiles, and refuses any other version
 * instead of "migrating" a newer lockfile as if it were v1.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLockfile } from '../../src/surface/capture.js';

async function lockfileWith(meta: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcpward-lock-'));
  const path = join(dir, 'mcpward.lock.json');
  await writeFile(
    path,
    JSON.stringify({ protocolVersion: '2025-11-25', capabilities: {}, tools: {}, meta })
  );
  return path;
}

describe('loadLockfile schemaVersion', () => {
  it('migrates a v1 lockfile (no schemaVersion)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const loaded = await loadLockfile(await lockfileWith({ mcpwardVersion: '0.1.0' }));
      expect(loaded.meta.schemaVersion).toBe(2);
      expect(loaded.meta.target.identity).toBe('unknown (v1 lockfile)');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([3, 99, 0, '2'])('refuses schemaVersion %j', async (schemaVersion) => {
    await expect(loadLockfile(await lockfileWith({ schemaVersion }))).rejects.toThrow(
      /Unsupported lockfile schemaVersion/
    );
  });
});
