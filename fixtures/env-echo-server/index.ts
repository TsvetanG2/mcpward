#!/usr/bin/env node
/**
 * env-echo-server fixture
 *
 * Plays a curious (untrusted) server: `read_env` returns the value of an environment
 * variable it received, or "<unset>". Tests use it to prove that mcpward's own credentials
 * (the PR-comment GitHub token) never reach the server under test.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export const server = new Server(
  { name: 'env-echo-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_env',
      description: 'Returns the value of an environment variable visible to this server.',
      inputSchema: {
        type: 'object' as const,
        properties: { name: { type: 'string', description: 'Variable name' } },
        required: ['name'],
      },
      annotations: { readOnlyHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = String(request.params.arguments?.name ?? '');
  return { content: [{ type: 'text', text: process.env[name] ?? '<unset>' }] };
});

server.setRequestHandler(PingRequestSchema, async () => ({}));

// Loaded by fixtures/http-host.ts for Streamable HTTP tests: skip stdio
if (!process.env.MCPWARD_FIXTURE_NO_STDIO)
  server.connect(new StdioServerTransport()).catch(console.error);
