/**
 * Surface capture module.
 *
 * Captures the current server surface (tools, schemas, descriptions)
 * and saves to a lockfile for drift detection.
 */

import { createHash } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import type { McpConnection } from '../client/connect.js';
import type { Tool, JsonSchema } from '../checks/schema.js';
import type { ServerSurface, ToolSurface } from './types.js';

// Package version for lockfile metadata
const MCPWARD_VERSION = '0.1.0';

/**
 * Computes SHA-256 hash of a description string.
 * Used for rug-pull detection - if the hash changes, the description changed.
 */
export function hashDescription(description: string | undefined): string {
  const text = description ?? '';
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Captures a single tool's surface.
 */
export function captureToolSurface(tool: Tool): ToolSurface {
  return {
    descriptionHash: hashDescription(tool.description),
    inputSchema: (tool.inputSchema as JsonSchema) ?? null,
    outputSchema: (tool.outputSchema as JsonSchema) ?? null,
    annotations: tool.annotations
      ? {
          readOnlyHint: tool.annotations.readOnlyHint,
          destructiveHint: tool.annotations.destructiveHint,
          idempotentHint: tool.annotations.idempotentHint,
          openWorldHint: tool.annotations.openWorldHint,
        }
      : null,
  };
}

/**
 * Captures the full server surface from an active connection.
 */
export async function captureServerSurface(
  connection: McpConnection
): Promise<ServerSurface> {
  // Get tools list
  const toolsResult = await connection.client.listTools();
  const tools = toolsResult.tools as Tool[];

  // Build tool surfaces map
  const toolSurfaces: Record<string, ToolSurface> = {};
  for (const tool of tools) {
    toolSurfaces[tool.name] = captureToolSurface(tool);
  }

  const caps = connection.capabilities as Record<string, unknown>;
  return {
    protocolVersion: connection.protocolVersion,
    capabilities: {
      tools: (caps.tools as Record<string, unknown>) ?? {},
      resources: (caps.resources as Record<string, unknown>) ?? {},
      prompts: (caps.prompts as Record<string, unknown>) ?? {},
    },
    tools: toolSurfaces,
    meta: {
      mcpwardVersion: MCPWARD_VERSION,
      capturedAt: new Date().toISOString(),
      serverName: connection.serverInfo.name,
      serverVersion: connection.serverInfo.version,
    },
  };
}

/**
 * Saves a server surface to a lockfile.
 */
export async function saveLockfile(
  surface: ServerSurface,
  path: string
): Promise<void> {
  const json = JSON.stringify(surface, null, 2);
  await writeFile(path, json, 'utf8');
}

/**
 * Loads a server surface from a lockfile.
 */
export async function loadLockfile(path: string): Promise<ServerSurface> {
  const content = await readFile(path, 'utf8');
  return JSON.parse(content) as ServerSurface;
}
