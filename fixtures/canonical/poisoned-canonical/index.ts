#!/usr/bin/env node
/**
 * poisoned-canonical fixture
 *
 * Has a description that differs from identical-v1 ONLY by an injected
 * zero-width character (U+200B ZERO WIDTH SPACE).
 *
 * CRITICAL TEST: This is the false-negative guard.
 * Expected behavior:
 * 1. Security check MUST fire (detects the zero-width character)
 * 2. Description hash MUST be different from identical-v1
 * 3. Canonicalization MUST NOT strip the zero-width character before security scan
 *
 * If the security check doesn't fire, canonicalization is stripping the character
 * before the security check sees it - a false negative, the worst bug class.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'canonical-test-poisoned',
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
        // Description with injected U+200B (ZERO WIDTH SPACE) after "tool"
        // "A test\u200B tool" - invisible but present
        description: 'A test\u200B tool for canonicalization.\nCafé with NFC é.',
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
