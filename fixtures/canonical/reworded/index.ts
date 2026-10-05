#!/usr/bin/env node
/**
 * reworded fixture
 *
 * Has the same tool as identical-v1 but with a GENUINELY different description.
 * Used to verify that canonicalization doesn't suppress real description changes.
 *
 * Expected: description_changed finding when compared to identical-v1
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'canonical-test-reworded',
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
        name: 'test_tool',
        // GENUINELY DIFFERENT description - semantically changed
        description: 'This tool has been completely rewritten with new wording.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: {
              type: 'string',
              description: 'User name',
            },
            age: {
              type: 'number',
              description: 'User age',
            },
          },
          required: ['name'],
        },
      },
    ],
  };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'test_tool') {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Test tool executed',
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
