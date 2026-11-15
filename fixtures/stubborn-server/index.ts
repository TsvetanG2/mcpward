#!/usr/bin/env node
/**
 * stubborn-server fixture
 *
 * A server that refuses to exit, to test that mcpward never leaves a server process behind.
 *
 * Behavior:
 * - Ignores stdin EOF and SIGTERM; only SIGKILL (or TerminateProcess on Windows) stops it
 * - Writes its own pid to STUBBORN_PID_FILE, so a test can check the process is gone
 * - STUBBORN_MODE selects the handshake:
 *   - silent: never answers initialize (connect timeout)
 *   - reject: answers initialize with an error (the SDK closes the transport by itself)
 *   - spawn-on-eof: answers normally; on stdin EOF (mcpward closing) starts a worker that is
 *     just as stubborn and writes its pid to STUBBORN_WORKER_PID_FILE — a process that did
 *     not exist when mcpward first looked at the tree
 *   - otherwise: answers normally and lists one tool
 *
 * Run it through a wrapper (`npx tsx ...`) and it is a grandchild of mcpward: killing the
 * direct child is not enough.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const mode = process.env.STUBBORN_MODE;
const pidFile = process.env.STUBBORN_PID_FILE;
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}

process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);

const STUBBORN_WORKER = `
  process.on('SIGTERM', () => {});
  require('node:fs').writeFileSync(process.argv[1], String(process.pid));
  setInterval(() => {}, 1000);
`;

process.stdin.on('end', () => {
  const workerPidFile = process.env.STUBBORN_WORKER_PID_FILE;
  if (mode === 'spawn-on-eof' && workerPidFile) {
    spawn(process.execPath, ['-e', STUBBORN_WORKER, workerPidFile], { stdio: 'ignore' });
  }
});

if (mode === 'silent') {
  process.stdin.resume();
} else if (mode === 'reject') {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (message.method === 'initialize') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: 'initialize rejected by fixture' },
        }) + '\n'
      );
    }
  });
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
