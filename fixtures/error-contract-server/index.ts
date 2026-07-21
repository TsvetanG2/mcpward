#!/usr/bin/env node
/**
 * error-contract-server fixture
 *
 * An MCP server that violates the two-layer error contract.
 * Used to test error contract check failures.
 *
 * Two-layer error contract rules:
 * 1. Protocol errors (JSON-RPC error): unknown tool, malformed call, invalid params
 * 2. Tool errors (isError: true): tool execution failures (file not found, etc.)
 *
 * This server intentionally violates these rules.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'error-contract-server',
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
        name: 'read_file',
        description: 'Reads a file. INCORRECTLY throws protocol error on file not found.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file to read',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'correct_tool_error',
        description: 'A tool that CORRECTLY uses tool-level error (isError: true) for failures.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            should_fail: {
              type: 'boolean',
              description: 'If true, returns a tool-level error',
            },
          },
        },
      },
      {
        name: 'fake_protocol_error',
        description: 'Returns isError:true when it should throw a protocol error for invalid params.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            value: {
              type: 'number',
              description: 'A number value (required for valid params)',
            },
          },
          required: ['value'],
        },
      },
    ],
  };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'read_file': {
      const path = (args as { path?: string })?.path;

      // VIOLATION: File not found should be a tool error (isError: true),
      // but we throw a protocol error instead
      if (path === '/nonexistent') {
        throw new McpError(
          ErrorCode.InternalError,
          `File not found: ${path}`
        );
      }

      return {
        content: [{ type: 'text', text: `Contents of ${path}` }],
      };
    }

    case 'correct_tool_error': {
      const shouldFail = (args as { should_fail?: boolean })?.should_fail;
      if (shouldFail) {
        // CORRECT: Tool execution failure uses isError: true
        return {
          content: [{ type: 'text', text: 'Tool execution failed' }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: 'Success' }],
      };
    }

    case 'fake_protocol_error': {
      const value = (args as { value?: number })?.value;

      // VIOLATION: Invalid/missing params should be a protocol error (-32602),
      // but we return isError: true instead
      if (typeof value !== 'number') {
        return {
          content: [{ type: 'text', text: 'Invalid params: value must be a number' }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: `Value: ${value}` }],
      };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
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
