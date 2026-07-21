#!/usr/bin/env node
/**
 * slow-server fixture
 *
 * An MCP server that responds slowly to blow latency budgets.
 * Used to test latency check failures.
 *
 * Features:
 * - Normal handshake (compliant)
 * - Tools that have configurable delays
 * - Should FAIL latency checks with typical budgets
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'slow-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper to sleep
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'slow_echo',
        description: 'Echoes back the message after a configurable delay.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            message: {
              type: 'string',
              description: 'The message to echo back',
            },
            delay_ms: {
              type: 'number',
              description: 'Delay in milliseconds before responding (default: 1500)',
            },
          },
          required: ['message'],
        },
      },
      {
        name: 'always_slow',
        description: 'A tool that always takes 2 seconds to respond.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'fast_tool',
        description: 'A fast tool for comparison - responds immediately.',
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
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'slow_echo': {
      const message = (args as { message?: string; delay_ms?: number })?.message ?? '';
      const delayMs = (args as { delay_ms?: number })?.delay_ms ?? 1500;

      await sleep(delayMs);

      return {
        content: [{ type: 'text', text: message }],
      };
    }

    case 'always_slow': {
      // Always takes 2 seconds - should blow any reasonable p95 budget
      await sleep(2000);

      return {
        content: [{ type: 'text', text: 'Finally done!' }],
      };
    }

    case 'fast_tool': {
      // Responds immediately
      return {
        content: [{ type: 'text', text: 'Fast response' }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Ping handler
server.setRequestHandler(PingRequestSchema, async () => {
  return {};
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
