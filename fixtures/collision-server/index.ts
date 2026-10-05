#!/usr/bin/env node
/**
 * collision-server fixture (M4 description collision lint).
 *
 * | Pair                               | Descriptions   | Schemas                              | Expected   |
 * |------------------------------------|----------------|--------------------------------------|------------|
 * | search_orders / find_orders        | near-identical | {filter:{status,tags[]}} vs {status} | FIRES      |
 * | list_users / list_projects         | near-identical | structurally identical               | silent     |
 * | get_user / get_project             | near-identical | same required SHAPE, different names | silent     |
 * | send_email / add_numbers           | unrelated      | divergent                            | silent     |
 *
 * The list_users/list_projects and get_user/get_project negatives are the important ones:
 * if either fires, the check cries wolf on ordinary tool families and is worthless.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export const server = new Server(
  { name: 'collision-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // POSITIVE: nested filter object vs flat scalar, near-identical descriptions
    {
      name: 'search_orders',
      description: 'Find orders matching the given filter. Returns a list of orders.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filter: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['filter'],
      },
    },
    {
      name: 'find_orders',
      description: 'Find orders matching the given status. Returns a list of orders.',
      inputSchema: {
        type: 'object' as const,
        properties: { status: { type: 'string' } },
        required: ['status'],
      },
    },

    // NEGATIVE: a legitimate family — similar descriptions, identical structure
    {
      name: 'list_users',
      description: 'Lists all users in the workspace, newest first.',
      inputSchema: {
        type: 'object' as const,
        properties: { limit: { type: 'number' }, cursor: { type: 'string' } },
      },
    },
    {
      name: 'list_projects',
      description: 'Lists all projects in the workspace, newest first.',
      inputSchema: {
        type: 'object' as const,
        properties: { limit: { type: 'number' }, cursor: { type: 'string' } },
      },
    },

    // NEGATIVE: family with differently NAMED but same-shaped required params
    {
      name: 'get_user',
      description: 'Gets a single user record by its unique identifier.',
      inputSchema: {
        type: 'object' as const,
        properties: { user_id: { type: 'string' } },
        required: ['user_id'],
      },
    },
    {
      name: 'get_project',
      description: 'Gets a single project record by its unique identifier.',
      inputSchema: {
        type: 'object' as const,
        properties: { project_id: { type: 'string' } },
        required: ['project_id'],
      },
    },

    // NEGATIVE: divergent schemas, unrelated descriptions
    {
      name: 'send_email',
      description: 'Sends an email message to a recipient address.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message: {
            type: 'object',
            properties: { to: { type: 'string' }, body: { type: 'string' } },
          },
        },
        required: ['message'],
      },
    },
    {
      name: 'add_numbers',
      description: 'Adds two numbers together.',
      inputSchema: {
        type: 'object' as const,
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: `called ${request.params.name}` }],
}));

server.setRequestHandler(PingRequestSchema, async () => ({}));

// Loaded by fixtures/http-host.ts for Streamable HTTP tests: skip stdio
if (!process.env.MCPWARD_FIXTURE_NO_STDIO)
  server.connect(new StdioServerTransport()).catch(console.error);
