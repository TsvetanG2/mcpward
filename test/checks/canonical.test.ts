/**
 * Integration tests for canonicalization with fixtures.
 *
 * Tests M0 acceptance criteria:
 * 1. identical-v1 vs identical-v2 => zero drift findings
 * 2. identical-v1 vs reworded => description_changed fires
 * 3. poisoned-canonical => security check fires AND drift detection doesn't swallow it
 */

import { describe, test, expect } from 'vitest';
import { connect } from '../../src/client/connect.js';
import { captureServerSurface, saveLockfile } from '../../src/surface/capture.js';
import { diffSurfaces } from '../../src/surface/diff.js';
import { runSecurityChecks } from '../../src/checks/security.js';
import type { Config } from '../../src/config/schema.js';
import { testConfig } from '../helpers/config.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';

// Helper to create Config for stdio fixtures
function makeConfig(fixturePath: string): Config {
  return testConfig({
    server: {
      transport: 'stdio',
      command: 'npx',
      args: ['tsx', fixturePath],
      env: {},
    },
    checks: {},
    timeouts: {},
    suites: [],
  });
}

describe('Canonicalization integration', () => {
  test('identical-v1 vs identical-v2 produces zero drift', async () => {
    // Capture baseline from identical-v1
    const v1Connection = await connect(
      makeConfig('fixtures/canonical/identical-v1/index.ts')
    );

    const v1Config = makeConfig('fixtures/canonical/identical-v1/index.ts');
    const v1Surface = await captureServerSurface(v1Connection, v1Config);
    await v1Connection.close();

    // Capture current from identical-v2
    const v2Config = makeConfig('fixtures/canonical/identical-v2/index.ts');
    const v2Connection = await connect(v2Config);

    const v2Surface = await captureServerSurface(v2Connection, v2Config);
    await v2Connection.close();

    // Compare
    const diff = diffSurfaces(v1Surface, v2Surface);

    // ACCEPTANCE: Zero drift findings
    expect(diff.unchanged).toBe(true);
    expect(diff.changes).toHaveLength(0);
  }, 30000);

  test('identical-v1 vs reworded produces description_changed', async () => {
    // Capture baseline from identical-v1
    const v1Config = makeConfig('fixtures/canonical/identical-v1/index.ts');
    const v1Connection = await connect(v1Config);

    const v1Surface = await captureServerSurface(v1Connection, v1Config);
    await v1Connection.close();

    // Capture current from reworded
    const rewordedConfig = makeConfig('fixtures/canonical/reworded/index.ts');
    const rewordedConnection = await connect(rewordedConfig);

    const rewordedSurface = await captureServerSurface(rewordedConnection, rewordedConfig);
    await rewordedConnection.close();

    // Compare
    const diff = diffSurfaces(v1Surface, rewordedSurface);

    // ACCEPTANCE: description_changed fires
    expect(diff.unchanged).toBe(false);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]?.class).toBe('description_changed');
    expect(diff.changes[0]?.tool).toBe('test_tool');
  }, 30000);

  test('poisoned-canonical: security check fires AND different hash from identical-v1', async () => {
    // Capture baseline from identical-v1
    const v1Config = makeConfig('fixtures/canonical/identical-v1/index.ts');
    const v1Connection = await connect(v1Config);

    const v1Surface = await captureServerSurface(v1Connection, v1Config);
    await v1Connection.close();

    // Capture current from poisoned-canonical
    const poisonedConfig = makeConfig('fixtures/canonical/poisoned-canonical/index.ts');
    const poisonedConnection = await connect(poisonedConfig);

    const poisonedSurface = await captureServerSurface(poisonedConnection, poisonedConfig);

    // PART 1: Security check must fire
    const securityResults = await runSecurityChecks({
      connection: poisonedConnection,
    });

    await poisonedConnection.close();

    // ACCEPTANCE: Security check detects zero-width character
    const zeroWidthFindings = securityResults.filter(
      (r) => r.id === 'security/hidden-unicode'
    );
    expect(zeroWidthFindings.length).toBeGreaterThan(0);
    expect(zeroWidthFindings[0]?.status).toBe('fail');

    // PART 2: Hash must be different (drift detection)
    const diff = diffSurfaces(v1Surface, poisonedSurface);

    // ACCEPTANCE: description_changed fires (hash is different)
    expect(diff.unchanged).toBe(false);
    const descriptionChanges = diff.changes.filter(
      (c) => c.class === 'description_changed'
    );
    expect(descriptionChanges).toHaveLength(1);
    expect(descriptionChanges[0]?.tool).toBe('test_tool');

    // CRITICAL VERIFICATION: Both checks fire
    // This proves canonicalization didn't strip the zero-width character
    // before the security check saw it
  }, 30000);

  test('canonicalVersion field is present in lockfile', async () => {
    const config = makeConfig('fixtures/canonical/identical-v1/index.ts');
    const connection = await connect(config);

    const surface = await captureServerSurface(connection, config);
    await connection.close();

    // Verify canonicalVersion is set
    expect(surface.meta.canonicalVersion).toBe(1);
  }, 30000);

  test('lockfile can be saved and loaded with canonicalVersion', async () => {
    const config = makeConfig('fixtures/canonical/identical-v1/index.ts');
    const connection = await connect(config);

    const surface = await captureServerSurface(connection, config);
    await connection.close();

    // Save to temp lockfile
    const tmpDir = await mkdtemp(join(tmpdir(), 'mcpward-test-'));
    const lockfilePath = join(tmpDir, 'test.lock.json');

    try {
      await saveLockfile(surface, lockfilePath);

      // Load back
      const { loadLockfile } = await import('../../src/surface/capture.js');
      const loaded = await loadLockfile(lockfilePath);

      // Verify canonicalVersion persisted
      expect(loaded.meta.canonicalVersion).toBe(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30000);
});
