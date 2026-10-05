/**
 * Shared tool list for the output-drift fixtures (M3).
 *
 * output-v1 and output-v2 expose EXACTLY these tools with identical input schemas and
 * annotations, so any finding between them must come from output shape inference.
 *
 * Ground truth (output-v1 → output-v2):
 * | Tool         | Annotations        | Output change                        | Expected                         |
 * |--------------|--------------------|--------------------------------------|----------------------------------|
 * | get_status   | readOnly           | `uptime` removed                     | breaking_output_shape_change     |
 * | get_profile  | readOnly           | `owner` object → string (JSON text)  | breaking_output_shape_change     |
 * | get_metrics  | readOnly           | `p99` added                          | nonbreaking_output_shape_change  |
 * | get_feed     | readOnly           | none — values vary, optional fields  | NO finding                       |
 * | say_hello    | readOnly           | none — free text varies              | NO finding                       |
 * | lookup       | readOnly, req. arg | `value` removed                      | skipped unless allowlisted       |
 * | wipe_data    | destructive        | shape changes                        | REFUSED — must never be called   |
 *
 * wipe_data's shape changes on purpose: if mcpward ever calls it, a finding appears and
 * the test goes red.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export const OUTPUT_DRIFT_TOOLS = [
  {
    name: 'get_status',
    description: 'Returns the service status.',
    inputSchema: { type: 'object' as const, properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_profile',
    description: 'Returns the account profile as JSON text.',
    inputSchema: { type: 'object' as const, properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_metrics',
    description: 'Returns request latency metrics.',
    inputSchema: { type: 'object' as const, properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_feed',
    description: 'Returns the latest feed entries.',
    inputSchema: { type: 'object' as const, properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'say_hello',
    description: 'Returns a plain-text greeting.',
    inputSchema: { type: 'object' as const, properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lookup',
    description: 'Looks up a record by id.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Record id' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'wipe_data',
    description: 'Deletes all stored records.',
    inputSchema: { type: 'object' as const, properties: {} },
    annotations: { destructiveHint: true },
  },
];

export type ToolOutput =
  { structuredContent: Record<string, unknown>; text?: string } | { text: string };

/** Starts a stdio server exposing OUTPUT_DRIFT_TOOLS; `respond` builds each tool's output. */
export function startOutputDriftServer(
  version: string,
  respond: (tool: string, callIndex: number, args: Record<string, unknown>) => ToolOutput
): void {
  const server = new Server(
    { name: 'output-drift-server', version },
    { capabilities: { tools: {} } }
  );
  const callCounts = new Map<string, number>();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: OUTPUT_DRIFT_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const index = callCounts.get(name) ?? 0;
    callCounts.set(name, index + 1);
    const out = respond(name, index, request.params.arguments ?? {});
    if ('structuredContent' in out) {
      return {
        content: [{ type: 'text', text: out.text ?? JSON.stringify(out.structuredContent) }],
        structuredContent: out.structuredContent,
      };
    }
    return { content: [{ type: 'text', text: out.text }] };
  });

  server.setRequestHandler(PingRequestSchema, async () => ({}));

  server.connect(new StdioServerTransport()).catch(console.error);
}

/**
 * get_feed: identical STRUCTURE in both versions, but values vary per call and two
 * fields are optional/nullable. Inference over 3 samples must call this a stable shape.
 * - `note` present on calls 0 and 2 only (optional)
 * - `cursor` is null on call 1 (nullable)
 */
export function feedOutput(callIndex: number): ToolOutput {
  const entry: Record<string, unknown> = {
    id: `entry-${Date.now()}-${callIndex}`,
    score: Math.random(),
    tags: callIndex === 0 ? [] : ['news', `t${callIndex}`],
  };
  if (callIndex % 2 === 0) entry.note = `note ${callIndex}`;
  return {
    structuredContent: {
      fetchedAt: new Date().toISOString(),
      cursor: callIndex === 1 ? null : `c${callIndex}`,
      entries: [entry],
    },
  };
}

export function helloOutput(): ToolOutput {
  return { text: `Hello at ${new Date().toISOString()} (${Math.random()})` };
}
