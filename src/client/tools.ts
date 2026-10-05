import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '../checks/schema.js';

/**
 * Upper bound on tools/list pages. The server is untrusted: a cursor that never
 * terminates must produce a clean error, not an infinite loop.
 */
const MAX_PAGES = 1000;

/**
 * Lists ALL tools, following `nextCursor` pagination.
 *
 * Every check must see the full surface. Reading only the first page would let a
 * server hide a poisoned tool on page 2 and get a clean report — a false negative.
 */
export async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...(result.tools as Tool[]));

    const next = result.nextCursor;
    if (next === undefined || next === null || next === '') {
      return tools;
    }
    if (seenCursors.has(next)) {
      throw new Error(`tools/list pagination loop: cursor "${next}" was returned twice`);
    }
    seenCursors.add(next);
    cursor = next;
  }

  throw new Error(`tools/list exceeded ${MAX_PAGES} pages`);
}
