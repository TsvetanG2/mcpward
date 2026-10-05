/**
 * tools/list pagination tests.
 *
 * A check that reads only the first page lets a server hide a poisoned tool on
 * page 2 — a false negative. These tests pin that every page is read, and that
 * a hostile cursor cannot hang the run.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connect } from '../../src/client/connect.js';
import { listAllTools } from '../../src/client/tools.js';
import { runSecurityChecks } from '../../src/checks/security.js';
import type { Config } from '../../src/config/schema.js';

const PAGINATED_SERVER = join(process.cwd(), 'fixtures', 'paginated-server', 'index.ts');

const paginatedConfig: Config = {
  server: { transport: 'stdio', command: 'npx', args: ['tsx', PAGINATED_SERVER], env: {} },
  checks: {},
  suites: [],
};

/** Fake client whose listTools replays the given pages keyed by cursor. */
function fakeClient(
  pages: Record<string, { tools: { name: string }[]; nextCursor?: string }>
): Client {
  return {
    listTools: async (params?: { cursor?: string }) => {
      const page = pages[params?.cursor ?? ''];
      if (!page) throw new Error(`unexpected cursor ${params?.cursor}`);
      return page;
    },
  } as unknown as Client;
}

describe('listAllTools', () => {
  it('follows nextCursor across pages', async () => {
    const client = fakeClient({
      '': { tools: [{ name: 'a' }], nextCursor: 'p2' },
      p2: { tools: [{ name: 'b' }], nextCursor: 'p3' },
      p3: { tools: [{ name: 'c' }] },
    });
    const tools = await listAllTools(client);
    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('rejects a cursor loop instead of hanging', async () => {
    const client = fakeClient({
      '': { tools: [{ name: 'a' }], nextCursor: 'p2' },
      p2: { tools: [{ name: 'b' }], nextCursor: 'p2' },
    });
    await expect(listAllTools(client)).rejects.toThrow(/pagination loop/);
  });

  it('reads the real paginated fixture in full', async () => {
    const connection = await connect(paginatedConfig);
    try {
      const tools = await listAllTools(connection.client);
      expect(tools.map((t) => t.name)).toEqual(['page_one_tool', 'page_two_injection']);
    } finally {
      await connection.close();
    }
  });

  it('security check sees the poisoned tool hidden on page 2', async () => {
    const connection = await connect(paginatedConfig);
    try {
      const results = await runSecurityChecks({ connection });
      const page2Findings = results.filter(
        (r) => r.status === 'fail' && r.location === 'page_two_injection'
      );
      expect(page2Findings.map((r) => r.id)).toEqual(
        expect.arrayContaining(['security/injection-pattern', 'security/hidden-unicode'])
      );
    } finally {
      await connection.close();
    }
  });
});
