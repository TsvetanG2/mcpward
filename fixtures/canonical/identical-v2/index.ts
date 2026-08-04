#!/usr/bin/env node
/**
 * identical-v2 fixture
 *
 * Logically identical to identical-v1 but with different serialization:
 * - Reordered schema keys
 * - \r\n line endings in description
 * - NFD-composed accented characters (café = cafe + combining accent)
 * - Some explicit undefined fields
 *
 * Expected: zero drift when compared to identical-v1 (canonicalization eliminates differences)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'canonical-test-v2',
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
        // Description with:
        // - \r\n line endings
        // - NFD-composed é (e + U+0301 combining acute accent)
        description: 'A test tool for canonicalization.\r\nCafé with NFC é.'.normalize('NFD'),
        inputSchema: {
          // Keys deliberately reordered: properties before type
          properties: {
            // age before name (alphabetically reordered)
            age: {
              description: 'User age',
              type: 'number',
              // Explicit undefined (should be dropped by canonicalization)
              default: undefined,
            },
            name: {
              description: 'User name',
              type: 'string',
            },
          },
          type: 'object' as const,
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
