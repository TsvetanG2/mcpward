#!/usr/bin/env node
/**
 * stubborn-server fixture
 *
 * A server that refuses to exit, to test that mcpward never leaves a server process behind.
 *
 * Behavior:
 * - Ignores stdin EOF and SIGTERM; only SIGKILL (or TerminateProcess on Windows) stops it
 * - Writes its own pid to STUBBORN_PID_FILE, so a test can check the process is gone
 * - STUBBORN_MODE=silent: never answers initialize (connect timeout)
 * - otherwise: answers normally and lists one tool
 *
 * Run it through a wrapper (`npx tsx ...`) and it is a grandchild of mcpward: killing the
 * direct child is not enough.
 */

import { writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const pidFile = process.env.STUBBORN_PID_FILE;
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}

process.on('SIGTERM', () => {});
process.stdin.on('end', () => {});
setInterval(() => {}, 1000);

if (process.env.STUBBORN_MODE === 'silent') {
  process.stdin.resume();
} else {
  const server = new Server(
    { name: 'stubborn-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'noop',
        description: 'Does nothing. Used to test that the server process is cleaned up.',
        inputSchema: { type: 'object' as const, properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
  }));
  await server.connect(new StdioServerTransport());
}
