#!/usr/bin/env node
/**
 * drift/v2 fixture
 *
 * Updated version for drift detection tests.
 * Differences from v1:
 *
 * - removed_tool: ABSENT (was in v1) → tool_removed
 * - added_tool: NEW (not in v1) → tool_added
 * - echo: description CHANGED → description_changed
 * - compute: added REQUIRED field "multiplier" → breaking_schema_change
 * - query: added OPTIONAL field "limit" → nonbreaking_schema_change
 * - read_data: readOnlyHint changed true→false → annotation_changed
 * - stable_tool: UNCHANGED → no drift
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
    name: 'drift-server',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // removed_tool is ABSENT → tool_removed

      // NEW tool not in v1 → tool_added
      {
        name: 'added_tool',
        description: 'This tool is new in v2.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            data: {
              type: 'string',
              description: 'Some data',
            },
          },
        },
      },
      // Description CHANGED → description_changed (rug-pull!)
      {
        name: 'echo',
        description: 'Modified description: now it also logs the message internally.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            message: {
              type: 'string',
              description: 'The message to echo',
            },
          },
          required: ['message'],
        },
      },
      // Added REQUIRED field → breaking_schema_change
      {
        name: 'compute',
        description: 'Performs a computation.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            value: {
              type: 'number',
              description: 'The input value',
            },
            multiplier: {
              type: 'number',
              description: 'Multiplier to apply (new required field)',
            },
          },
          required: ['value', 'multiplier'],
        },
      },
      // Added OPTIONAL field → nonbreaking_schema_change
      {
        name: 'query',
        description: 'Queries data from the system.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            id: {
              type: 'string',
              description: 'The ID to query',
            },
            limit: {
              type: 'number',
              description: 'Optional limit on results (new optional field)',
            },
          },
          required: ['id'],
        },
      },
      // readOnlyHint changed true→false → annotation_changed
      {
        name: 'read_data',
        description: 'Reads data without modifying anything.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            path: {
              type: 'string',
              description: 'Path to read',
            },
          },
          required: ['path'],
        },
        annotations: {
          readOnlyHint: false,
        },
      },
      // Unchanged → no drift
      {
        name: 'stable_tool',
        description: 'This tool remains unchanged between versions.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            input: {
              type: 'string',
              description: 'Some input',
            },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  return {
    content: [{ type: 'text', text: `v2: called ${name}` }],
  };
});

server.setRequestHandler(PingRequestSchema, async () => {
  return {};
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
