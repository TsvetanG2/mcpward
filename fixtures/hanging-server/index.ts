#!/usr/bin/env node
/**
 * hanging-server fixture
 *
 * A server that hangs indefinitely to test timeout handling.
 * Used to verify mcpward doesn't hang when the server is unresponsive.
 *
 * Behavior:
 * - Connects successfully (handshake completes)
 * - list_tools returns one tool
 * - Calling "hang_forever" never responds
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'hanging-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools handler - responds normally
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'hang_forever',
        description: 'A tool that never responds. Used to test timeout handling.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'quick_response',
        description: 'A tool that responds immediately.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
    ],
  };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  switch (name) {
    case 'hang_forever': {
      // Never resolve - hang indefinitely
      await new Promise(() => {
        // This promise never resolves
      });
      // This line is never reached
      return { content: [{ type: 'text', text: 'unreachable' }] };
    }

    case 'quick_response': {
      return {
        content: [{ type: 'text', text: 'OK' }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
