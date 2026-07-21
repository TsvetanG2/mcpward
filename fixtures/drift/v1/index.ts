#!/usr/bin/env node
/**
 * drift/v1 fixture
 *
 * Baseline version for drift detection tests.
 * Compare with v2 to verify classifier detects each change type.
 *
 * Tools in v1:
 * - removed_tool: will be absent in v2 → tool_removed
 * - echo: description will change in v2 → description_changed
 * - compute: will gain a required field in v2 → breaking_schema_change
 * - query: will gain an optional field in v2 → nonbreaking_schema_change
 * - read_data: readOnlyHint=true, will flip to false in v2 → annotation_changed
 * - stable_tool: unchanged between versions → no drift
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
    version: '1.0.0',
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
      // This tool will be removed in v2 → tool_removed
      {
        name: 'removed_tool',
        description: 'This tool exists in v1 but will be removed in v2.',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      // Description will change in v2 → description_changed
      {
        name: 'echo',
        description: 'Original description: echoes back the message.',
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
      // Will gain a required field in v2 → breaking_schema_change
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
          },
          required: ['value'],
        },
      },
      // Will gain an optional field in v2 → nonbreaking_schema_change
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
          },
          required: ['id'],
        },
      },
      // readOnlyHint will flip false in v2 → annotation_changed
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
          readOnlyHint: true,
        },
      },
      // Unchanged between versions → no drift
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
    content: [{ type: 'text', text: `v1: called ${name}` }],
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
