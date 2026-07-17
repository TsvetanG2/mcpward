#!/usr/bin/env node
/**
 * good-server fixture
 *
 * A fully compliant MCP server that should pass ALL checks with zero findings.
 * This is the ground truth for "no false positives".
 *
 * Features:
 * - Correct protocol handshake
 * - Valid tool schemas with proper inputSchema
 * - Non-empty, clear descriptions
 * - Proper tool name format (alphanumeric + underscore/hyphen)
 * - Correct two-layer error handling
 * - Responds to ping
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
    name: 'good-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'echo',
        description: 'Echoes back the provided message. Useful for testing connectivity.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            message: {
              type: 'string',
              description: 'The message to echo back',
            },
          },
          required: ['message'],
        },
      },
      {
        name: 'add_numbers',
        description: 'Adds two numbers together and returns the sum.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            a: {
              type: 'number',
              description: 'First number to add',
            },
            b: {
              type: 'number',
              description: 'Second number to add',
            },
          },
          required: ['a', 'b'],
        },
      },
      {
        name: 'get-status',
        description: 'Returns the current server status. Always returns healthy.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'may_fail',
        description: 'A tool that may return a tool-level error (isError: true). Pass fail=true to trigger.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            fail: {
              type: 'boolean',
              description: 'If true, returns a tool-level error',
            },
          },
        },
      },
    ],
  };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'echo': {
      const message = (args as { message?: string })?.message;
      if (typeof message !== 'string') {
        // This should not happen if schema is followed, but handle gracefully
        return {
          content: [{ type: 'text', text: 'Error: message is required' }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: message }],
      };
    }

    case 'add_numbers': {
      const a = (args as { a?: number })?.a;
      const b = (args as { b?: number })?.b;
      if (typeof a !== 'number' || typeof b !== 'number') {
        return {
          content: [{ type: 'text', text: 'Error: a and b must be numbers' }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: String(a + b) }],
      };
    }

    case 'get-status': {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'healthy', uptime: 12345 }) }],
      };
    }

    case 'may_fail': {
      const fail = (args as { fail?: boolean })?.fail;
      if (fail) {
        // Tool-level error: returns successful result with isError: true
        return {
          content: [{ type: 'text', text: 'Intentional tool failure' }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: 'Success' }],
      };
    }

    default:
      // Unknown tool - this is a protocol error, thrown as exception
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Ping handler (SDK handles this automatically, but we can be explicit)
server.setRequestHandler(PingRequestSchema, async () => {
  return {};
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
