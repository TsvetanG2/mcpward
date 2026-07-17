#!/usr/bin/env node
/**
 * malformed-server fixture
 *
 * An MCP server with various compliance and schema violations.
 * Used to test that mcpward correctly detects problems.
 *
 * Problems included:
 * - Tool with empty description
 * - Tool with invalid name (contains spaces)
 * - Tool with invalid inputSchema (missing type)
 * - Tool that returns protocol error instead of tool error for business logic failure
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'malformed-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List tools handler - returns tools with various schema problems
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        // Valid tool for baseline comparison
        name: 'valid_tool',
        description: 'This tool is valid and should pass all checks.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            input: {
              type: 'string',
              description: 'Input value',
            },
          },
        },
      },
      {
        // Problem: Empty description
        name: 'empty_description',
        description: '',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        // Problem: Invalid name with spaces
        name: 'invalid name with spaces',
        description: 'This tool has an invalid name containing spaces.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        // Problem: Invalid name with special characters
        name: 'invalid@name!',
        description: 'This tool has an invalid name with special characters.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        // Problem: Missing description entirely (undefined/null becomes empty string)
        name: 'no_description',
        description: undefined as unknown as string,
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        // Problem: inputSchema with invalid JSON Schema (unknown type)
        name: 'bad_schema',
        description: 'This tool has an invalid inputSchema with unknown property type.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            value: {
              type: 'invalid_type_that_does_not_exist' as unknown as 'string',
              description: 'This has an invalid type',
            },
          },
        },
      },
      {
        // Tool that demonstrates wrong error handling
        name: 'wrong_error_layer',
        description: 'This tool throws a protocol error for business logic failures (WRONG).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            shouldFail: {
              type: 'boolean',
              description: 'If true, triggers wrong error handling',
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
    case 'valid_tool':
      return {
        content: [{ type: 'text', text: 'Valid response' }],
      };

    case 'empty_description':
    case 'no_description':
    case 'bad_schema':
      return {
        content: [{ type: 'text', text: 'Response from problematic tool' }],
      };

    case 'invalid name with spaces':
    case 'invalid@name!':
      return {
        content: [{ type: 'text', text: 'Response from invalid-named tool' }],
      };

    case 'wrong_error_layer': {
      const shouldFail = (args as { shouldFail?: boolean })?.shouldFail;
      if (shouldFail) {
        // WRONG: Using protocol error for business logic failure
        // Should use { content: [...], isError: true } instead
        throw new McpError(
          ErrorCode.InternalError,
          'Business logic failure - this should be isError: true, not a protocol error!'
        );
      }
      return {
        content: [{ type: 'text', text: 'Success' }],
      };
    }

    default:
      // This is correct - unknown tool should be a protocol error
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
