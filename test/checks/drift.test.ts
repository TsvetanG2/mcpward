/**
 * Integration tests for drift detection using drift/v1 and drift/v2 fixtures.
 *
 * These tests verify that the full drift detection pipeline works correctly:
 * 1. Capture baseline from v1 server
 * 2. Compare against v2 server
 * 3. Detect all expected drift classes
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { rm, mkdir } from 'fs/promises';
import { connect } from '../../src/client/connect.js';
import {
  captureServerSurface,
  saveLockfile,
  diffSurfaces,
} from '../../src/surface/index.js';
import { runDriftChecks } from '../../src/checks/drift.js';
import type { Config } from '../../src/config/schema.js';

// Fixture paths
const FIXTURES_DIR = join(process.cwd(), 'fixtures');
const V1_SERVER = join(FIXTURES_DIR, 'drift', 'v1', 'index.ts');
const V2_SERVER = join(FIXTURES_DIR, 'drift', 'v2', 'index.ts');
const TEMP_DIR = join(process.cwd(), 'test', '.temp');
const BASELINE_PATH = join(TEMP_DIR, 'test-baseline.lock.json');

// Config for v1 server
const v1Config: Config = {
  server: {
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', V1_SERVER],
    env: {},
  },
  checks: {},
  suites: [],
};

// Config for v2 server
const v2Config: Config = {
  server: {
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', V2_SERVER],
    env: {},
  },
  checks: {
    drift: {
      baseline: BASELINE_PATH,
      fail_on: [
        'tool_removed',
        'description_changed',
        'breaking_schema_change',
        'annotation_changed',
      ],
    },
  },
  suites: [],
};

describe('Drift Detection Integration', () => {
  beforeAll(async () => {
    // Create temp directory for test artifacts
    await mkdir(TEMP_DIR, { recursive: true });
  });

  afterAll(async () => {
    // Clean up temp directory
    try {
      await rm(TEMP_DIR, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Surface Capture', () => {
    it('captures v1 server surface correctly', async () => {
      const connection = await connect(v1Config);
      try {
        const surface = await captureServerSurface(connection);

        // Verify expected tools are captured
        expect(Object.keys(surface.tools).sort()).toEqual([
          'compute',
          'echo',
          'query',
          'read_data',
          'removed_tool',
          'stable_tool',
        ]);

        // Verify metadata
        expect(surface.meta.serverName).toBe('drift-server');
        expect(surface.meta.serverVersion).toBe('1.0.0');

        // Verify read_data has readOnlyHint
        expect(surface.tools['read_data']?.annotations?.readOnlyHint).toBe(true);
      } finally {
        await connection.close();
      }
    }, 30000);

    it('captures v2 server surface correctly', async () => {
      const connection = await connect(v2Config);
      try {
        const surface = await captureServerSurface(connection);

        // Verify expected tools (removed_tool absent, added_tool present)
        expect(Object.keys(surface.tools).sort()).toEqual([
          'added_tool',
          'compute',
          'echo',
          'query',
          'read_data',
          'stable_tool',
        ]);

        // Verify metadata
        expect(surface.meta.serverName).toBe('drift-server');
        expect(surface.meta.serverVersion).toBe('2.0.0');

        // Verify read_data has readOnlyHint changed
        expect(surface.tools['read_data']?.annotations?.readOnlyHint).toBe(false);
      } finally {
        await connection.close();
      }
    }, 30000);
  });

  describe('Drift Detection v1 → v2', () => {
    it('detects all expected drift classes', async () => {
      // Capture v1 baseline
      const v1Connection = await connect(v1Config);
      let v1Surface;
      try {
        v1Surface = await captureServerSurface(v1Connection);
        await saveLockfile(v1Surface, BASELINE_PATH);
      } finally {
        await v1Connection.close();
      }

      // Capture v2 surface
      const v2Connection = await connect(v2Config);
      let v2Surface;
      try {
        v2Surface = await captureServerSurface(v2Connection);
      } finally {
        await v2Connection.close();
      }

      // Compare surfaces
      const diff = diffSurfaces(v1Surface, v2Surface);

      expect(diff.unchanged).toBe(false);

      // Extract change classes
      const classes = diff.changes.map((c) => c.class);

      // Verify all expected drift classes are detected
      expect(classes).toContain('tool_removed'); // removed_tool
      expect(classes).toContain('tool_added'); // added_tool
      expect(classes).toContain('description_changed'); // echo description changed
      expect(classes).toContain('breaking_schema_change'); // compute got new required field
      expect(classes).toContain('nonbreaking_schema_change'); // query got new optional field
      expect(classes).toContain('annotation_changed'); // read_data readOnlyHint flipped

      // Verify specific tools
      const toolRemoved = diff.changes.find(
        (c) => c.class === 'tool_removed'
      );
      expect(toolRemoved?.tool).toBe('removed_tool');

      const toolAdded = diff.changes.find(
        (c) => c.class === 'tool_added'
      );
      expect(toolAdded?.tool).toBe('added_tool');

      const descChanged = diff.changes.find(
        (c) => c.class === 'description_changed'
      );
      expect(descChanged?.tool).toBe('echo');

      const annotChanged = diff.changes.find(
        (c) => c.class === 'annotation_changed'
      );
      expect(annotChanged?.tool).toBe('read_data');
    }, 60000);
  });

  describe('Drift Checks Integration', () => {
    it('runs drift checks against baseline', async () => {
      // First ensure baseline exists from previous test
      // or create it if needed
      const v1Connection = await connect(v1Config);
      try {
        const v1Surface = await captureServerSurface(v1Connection);
        await saveLockfile(v1Surface, BASELINE_PATH);
      } finally {
        await v1Connection.close();
      }

      // Run drift checks against v2
      const v2Connection = await connect(v2Config);
      try {
        const results = await runDriftChecks({
          connection: v2Connection,
          config: v2Config.checks?.drift,
        });

        // Should have failures
        const failures = results.filter((r) => r.status === 'fail');
        expect(failures.length).toBeGreaterThan(0);

        // Check that we detect the expected failing classes
        const failingIds = failures.map((r) => r.id);
        expect(failingIds).toContain('drift/tool_removed');
        expect(failingIds).toContain('drift/description_changed');
        expect(failingIds).toContain('drift/breaking_schema_change');
        expect(failingIds).toContain('drift/annotation_changed');

        // tool_added and nonbreaking_schema_change should NOT be in failures
        // (they're not in fail_on)
        expect(failingIds).not.toContain('drift/tool_added');
        expect(failingIds).not.toContain('drift/nonbreaking_schema_change');
      } finally {
        await v2Connection.close();
      }
    }, 60000);

    it('reports no drift when server matches baseline', async () => {
      // Create baseline from v1
      const v1Connection1 = await connect(v1Config);
      try {
        const surface = await captureServerSurface(v1Connection1);
        await saveLockfile(surface, BASELINE_PATH);
      } finally {
        await v1Connection1.close();
      }

      // Run drift checks against same v1 server
      const v1Connection2 = await connect(v1Config);
      try {
        const results = await runDriftChecks({
          connection: v1Connection2,
          config: {
            baseline: BASELINE_PATH,
            fail_on: ['tool_removed', 'description_changed'],
          },
        });

        // Should have no failures
        const failures = results.filter((r) => r.status === 'fail');
        expect(failures).toHaveLength(0);

        // Should have a pass result indicating no drift
        const passResult = results.find(
          (r) => r.id === 'drift/no-changes' && r.status === 'pass'
        );
        expect(passResult).toBeDefined();
      } finally {
        await v1Connection2.close();
      }
    }, 60000);

    it('skips drift checks when baseline is missing', async () => {
      const connection = await connect(v1Config);
      try {
        const results = await runDriftChecks({
          connection,
          config: {
            baseline: '/nonexistent/path/baseline.lock.json',
            fail_on: [],
          },
        });

        // Should have a skip result
        const skipResult = results.find(
          (r) => r.id === 'drift/baseline-missing' && r.status === 'skip'
        );
        expect(skipResult).toBeDefined();
      } finally {
        await connection.close();
      }
    }, 30000);
  });

  describe('stable_tool unchanged', () => {
    it('does not report drift for unchanged tool', async () => {
      // Capture v1 baseline
      const v1Connection = await connect(v1Config);
      let v1Surface;
      try {
        v1Surface = await captureServerSurface(v1Connection);
      } finally {
        await v1Connection.close();
      }

      // Capture v2 surface
      const v2Connection = await connect(v2Config);
      let v2Surface;
      try {
        v2Surface = await captureServerSurface(v2Connection);
      } finally {
        await v2Connection.close();
      }

      // Compare
      const diff = diffSurfaces(v1Surface, v2Surface);

      // stable_tool should NOT appear in any changes
      const stableToolChanges = diff.changes.filter(
        (c) => c.tool === 'stable_tool'
      );
      expect(stableToolChanges).toHaveLength(0);
    }, 60000);
  });
});
