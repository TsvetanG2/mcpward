#!/usr/bin/env node
/**
 * identical-v1 fixture
 *
 * Baseline version with standard serialization.
 * Used together with identical-v2 to test that canonicalization
 * eliminates false positives from:
 * - Reordered JSON keys
 * - Different line endings
 * - Different Unicode normalization (NFD vs NFC)
 * - Explicit vs implicit undefined
 *
 * Expected: zero drift when compared to identical-v2
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'canonical-test-v1',
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
        // Description with accented characters in NFC form
        description: 'A test tool for canonicalization.\nCafé with NFC é.',
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
