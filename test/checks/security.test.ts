/**
 * Security check tests
 *
 * Tests tool-poisoning heuristics:
 * 1. Injection patterns in descriptions
 * 2. Hidden unicode characters
 * 3. Secret-soliciting schemas
 * 4. Annotation/behavior mismatch
 *
 * CRITICAL: good-server must have ZERO false positives.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { connect } from '../../src/client/connect.js';
import { runSecurityChecks } from '../../src/checks/security.js';
import type { Config } from '../../src/config/schema.js';

// Fixture paths
const FIXTURES_DIR = join(process.cwd(), 'fixtures');
const GOOD_SERVER = join(FIXTURES_DIR, 'good-server', 'index.ts');
const POISONED_SERVER = join(FIXTURES_DIR, 'poisoned-server', 'index.ts');

// Config for good server
const goodServerConfig: Config = {
  server: {
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', GOOD_SERVER],
    env: {},
  },
  checks: {},
  suites: [],
};

// Config for poisoned server
const poisonedServerConfig: Config = {
  server: {
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', POISONED_SERVER],
    env: {},
  },
  checks: {},
  suites: [],
};

describe('Security Checks', () => {
  describe('against good-server (ZERO false positives)', () => {
    it('finds no security issues', async () => {
      const connection = await connect(goodServerConfig);
      try {
        const results = await runSecurityChecks({ connection });

        // Filter out summary
        const findings = results.filter(
          (r) => r.status === 'fail' && r.id !== 'security/summary'
        );

        // Must be ZERO false positives
        expect(findings).toHaveLength(0);

        // Summary should pass
        const summary = results.find((r) => r.id === 'security/summary');
        expect(summary?.status).toBe('pass');
      } finally {
        await connection.close();
      }
    }, 30000);
  });

  describe('against poisoned-server (all heuristics trip)', () => {
    it('detects injection patterns', async () => {
      const connection = await connect(poisonedServerConfig);
      try {
        const results = await runSecurityChecks({ connection });

        const injectionFindings = results.filter(
          (r) => r.id === 'security/injection-pattern' && r.status === 'fail'
        );

        // Should find injection patterns in injection_tool and search_docs
        expect(injectionFindings.length).toBeGreaterThanOrEqual(2);

        // Check specific tools
        const injectionTool = injectionFindings.find(
          (r) => r.location === 'injection_tool'
        );
        expect(injectionTool).toBeDefined();
        expect(injectionTool?.message).toContain('injection-like pattern');

        const searchDocs = injectionFindings.find(
          (r) => r.location === 'search_docs.query'
        );
        expect(searchDocs).toBeDefined();
      } finally {
        await connection.close();
      }
    }, 30000);

    it('detects hidden unicode characters', async () => {
      const connection = await connect(poisonedServerConfig);
      try {
        const results = await runSecurityChecks({ connection });

        const unicodeFindings = results.filter(
          (r) => r.id === 'security/hidden-unicode' && r.status === 'fail'
        );

        // Should find hidden unicode in safetool (name and description) and display_text
        expect(unicodeFindings.length).toBeGreaterThanOrEqual(3);

        // Check for zero-width detection
        const zeroWidth = unicodeFindings.find((r) =>
          r.message.includes('zero-width')
        );
        expect(zeroWidth).toBeDefined();

        // Check for bidirectional override detection
        const bidi = unicodeFindings.find((r) =>
          r.message.includes('bidirectional')
        );
        expect(bidi).toBeDefined();
      } finally {
        await connection.close();
      }
    }, 30000);

    it('detects secret-soliciting schemas', async () => {
      const connection = await connect(poisonedServerConfig);
      try {
        const results = await runSecurityChecks({ connection });

        const secretFindings = results.filter(
          (r) => r.id === 'security/secret-in-schema' && r.status === 'fail'
        );

        // Should find in api_connector and login_helper
        expect(secretFindings.length).toBeGreaterThanOrEqual(2);

        // Check api_connector
        const apiConnector = secretFindings.find(
          (r) => r.location === 'api_connector'
        );
        expect(apiConnector).toBeDefined();
        expect(apiConnector?.message).toContain('api_key');
        expect(apiConnector?.message).toContain('password');

        // Check login_helper
        const loginHelper = secretFindings.find(
          (r) => r.location === 'login_helper'
        );
        expect(loginHelper).toBeDefined();
        expect(loginHelper?.message).toContain('secret');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('detects annotation/behavior mismatch', async () => {
      const connection = await connect(poisonedServerConfig);
      try {
        const results = await runSecurityChecks({ connection });

        const mismatchFindings = results.filter(
          (r) => r.id === 'security/annotation-mismatch' && r.status === 'fail'
        );

        // Should find in delete_files
        expect(mismatchFindings.length).toBeGreaterThanOrEqual(1);

        const deleteFiles = mismatchFindings.find(
          (r) => r.location === 'delete_files'
        );
        expect(deleteFiles).toBeDefined();
        expect(deleteFiles?.message).toContain('readOnlyHint=true');
        expect(deleteFiles?.message).toContain('implies mutation');
      } finally {
        await connection.close();
      }
    }, 30000);

    it('summary reports total findings', async () => {
      const connection = await connect(poisonedServerConfig);
      try {
        const results = await runSecurityChecks({ connection });

        const summary = results.find((r) => r.id === 'security/summary');
        expect(summary?.status).toBe('fail');
        expect(summary?.message).toContain('issue(s)');
      } finally {
        await connection.close();
      }
    }, 30000);
  });

  describe('clean_tool in poisoned-server', () => {
    it('does not flag the clean tool', async () => {
      const connection = await connect(poisonedServerConfig);
      try {
        const results = await runSecurityChecks({ connection });

        // clean_tool should not appear in any findings
        const cleanToolFindings = results.filter(
          (r) => r.location === 'clean_tool' && r.status === 'fail'
        );

        expect(cleanToolFindings).toHaveLength(0);
      } finally {
        await connection.close();
      }
    }, 30000);
  });
});
