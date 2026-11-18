/**
 * Collects real tool definitions for test/corpus/registry-clean/ — the clean corpus the security
 * detectors must not flag. Uses the network; tests never run it. Run with `pnpm build` first.
 *
 * Source: the official MCP Registry (https://registry.modelcontextprotocol.io), latest version of
 * each server. Only servers with a public Streamable HTTP remote are contacted, without any
 * credentials or extra headers. Each one gets `initialize` + `tools/list` through the official
 * SDK client and nothing else: no tool is ever called, and no package is downloaded or run.
 *
 * Usage: node scripts/collect-registry-tools.mjs [maxTools=400] [perServer=4]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const MAX_TOOLS = Number(process.argv[2] ?? 400);
const PER_SERVER = Number(process.argv[3] ?? 4);
const TIMEOUT_MS = 10_000;
const CONCURRENCY = 8;
const OUT = 'test/corpus/registry-clean';

async function* latestServers() {
  let cursor;
  do {
    const url = new URL(REGISTRY);
    url.searchParams.set('limit', '100');
    url.searchParams.set('version', 'latest');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`registry ${res.status}`);
    const page = await res.json();
    for (const entry of page.servers) {
      // `version=latest` is not honoured by the API: filter on the registry's own flag
      if (entry._meta?.['io.modelcontextprotocol.registry/official']?.isLatest) yield entry.server;
    }
    cursor = page.metadata?.nextCursor;
  } while (cursor);
}

/** A public Streamable HTTP remote: no URL template variables, no required headers. */
function publicRemote(server) {
  return server.remotes?.find(
    (r) =>
      r.type === 'streamable-http' &&
      !r.url.includes('{') &&
      !(r.headers ?? []).some((h) => h.isRequired)
  );
}

async function listTools(url) {
  const client = new Client({ name: 'mcpward-corpus', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  try {
    await client.connect(transport, { signal: deadline, timeout: TIMEOUT_MS });
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        signal: deadline,
        timeout: TIMEOUT_MS,
      });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < PER_SERVER);
    return tools;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Only the fields the security detectors read. */
const slim = ({ name, title, description, inputSchema, annotations }) => ({
  name,
  ...(title === undefined ? {} : { title }),
  ...(description === undefined ? {} : { description }),
  inputSchema,
  ...(annotations === undefined ? {} : { annotations }),
});

const entries = [];
const stats = { servers: 0, contacted: 0, answered: 0, failed: 0 };
// The registry lists every version: keep the latest one per server name
const latest = new Map();
for await (const server of latestServers()) {
  stats.servers++;
  const remote = publicRemote(server);
  if (remote) latest.set(server.name, { server, url: remote.url });
}
// Spread over the whole alphabet instead of the first names: every k-th server, deterministic
const all = [...latest.values()].sort((a, b) => a.server.name.localeCompare(b.server.name));
const stride = Math.max(1, Math.floor(all.length / 300));
const queue = all.filter((_, i) => i % stride === 0);
// Contact them in a fixed pseudo-random order, so the tool limit does not stop at the letter "f"
let seed = 1;
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
for (let i = queue.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [queue[i], queue[j]] = [queue[j], queue[i]];
}

let next = 0;
async function worker() {
  while (next < queue.length && entries.length < MAX_TOOLS) {
    const { server, url } = queue[next++];
    stats.contacted++;
    try {
      const tools = (await listTools(url)).slice(0, PER_SERVER);
      if (tools.length > 0) stats.answered++;
      for (const tool of tools) {
        if (entries.length >= MAX_TOOLS) break;
        entries.push({ server: server.name, version: server.version, url, tool: slim(tool) });
      }
    } catch {
      stats.failed++;
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

entries.sort((a, b) => a.server.localeCompare(b.server) || a.tool.name.localeCompare(b.tool.name));
const date = new Date().toISOString().slice(0, 10);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/tools-${date}.json`, JSON.stringify(entries, null, 2) + '\n');
console.log(
  JSON.stringify(
    { date, ...stats, unique: all.length, sampled: queue.length, tools: entries.length },
    null,
    2
  )
);
process.exit(0);
