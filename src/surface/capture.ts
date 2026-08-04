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
import type { Config } from '../config/schema.js';
import {
  canonicalizeDescription,
  canonicalizeSchema,
} from './canonical.js';
import { MCPWARD_VERSION } from '../version.js';

/**
 * Computes SHA-256 hash of a description string.
 * Used for rug-pull detection - if the hash changes, the description changed.
 *
 * CRITICAL: Hashes the CANONICAL form to avoid false positives from:
 * - Reordered JSON keys
 * - Different line endings (\r\n vs \n)
 * - Different Unicode normalization (NFD vs NFC)
 * - Whitespace variations
 *
 * The raw description is preserved for security checks (see src/checks/security.ts).
 */
export function hashDescription(description: string | undefined): string {
  // Hash the canonical form only
  const canonical = canonicalizeDescription(description);
  const hash = createHash('sha256').update(canonical, 'utf-8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Computes a stable non-reversible fingerprint of credential material.
 *
 * CRITICAL SECURITY: Never store actual credentials in the lockfile.
 * The lockfile is committed to git.
 *
 * Returns sha256(credential + serverIdentity) truncated to 16 hex chars.
 * This allows detecting "same credential as last time" without storing secrets.
 *
 * @param credential - The credential value (API key, token, password, etc.)
 * @param serverIdentity - The server identity to salt the hash
 * @returns 16-character hex fingerprint, or null if input is invalid
 */
function fingerprintCredential(
  credential: string | undefined,
  serverIdentity: string
): string | null {
  if (!credential || !serverIdentity) return null;

  try {
    const hash = createHash('sha256')
      .update(credential + serverIdentity, 'utf-8')
      .digest('hex');
    // Truncate to 16 chars - enough entropy for "same credential" detection
    return hash.substring(0, 16);
  } catch {
    return null;
  }
}

/**
 * Captures a single tool's surface.
 *
 * Stores CANONICAL forms of inputSchema and outputSchema to avoid false drift
 * from key reordering, Unicode normalization differences, etc.
 *
 * @param tool - The tool to capture
 * @param fullText - Whether to store full description text (from config)
 */
export function captureToolSurface(
  tool: Tool,
  fullText = true
): ToolSurface {
  const inputSchema = (tool.inputSchema as JsonSchema) ?? null;
  const outputSchema = (tool.outputSchema as JsonSchema) ?? null;

  // Canonical description for storage (if full_text enabled)
  const description = fullText
    ? canonicalizeDescription(tool.description)
    : null;

  return {
    descriptionHash: hashDescription(tool.description),
    description,
    // Store canonical forms to avoid false drift from key order, etc.
    inputSchema: canonicalizeSchema(inputSchema),
    outputSchema: canonicalizeSchema(outputSchema),
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
 *
 * @param connection - Active MCP connection
 * @param config - mcpward configuration (for full_text, auth context, etc.). Optional, uses defaults if not provided.
 */
export async function captureServerSurface(
  connection: McpConnection,
  config?: Config
): Promise<ServerSurface> {
  // Get tools list
  const toolsResult = await connection.client.listTools();
  const tools = toolsResult.tools as Tool[];

  // Get full_text config option (default true)
  const fullText = config?.checks?.drift?.full_text ?? true;

  // Build tool surfaces map
  const toolSurfaces: Record<string, ToolSurface> = {};
  for (const tool of tools) {
    toolSurfaces[tool.name] = captureToolSurface(tool, fullText);
  }

  // Build target identity (M1 provenance)
  // If no config, use default stdio unknown
  const target = config
    ? buildTargetIdentity(config.server)
    : { transport: 'stdio' as const, identity: 'unknown (no config)' };

  // Build auth context (M1 auth-scoped baselines)
  const authContext = config
    ? buildAuthContext(config.server, target.identity)
    : { kind: 'none' as const, keys: [], fingerprint: null, label: null };

  // Build environment info (M1 provenance)
  const environment = buildEnvironment();

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
      schemaVersion: 2,
      mcpwardVersion: MCPWARD_VERSION,
      canonicalVersion: 1,
      capturedAt: new Date().toISOString(),
      serverName: connection.serverInfo.name,
      serverVersion: connection.serverInfo.version,
      target,
      authContext,
      environment,
    },
  };
}

/**
 * Builds target identity from server config.
 * stdio: command + args (NO env values)
 * http: origin + path (NO query string, NO headers)
 */
function buildTargetIdentity(
  server: Config['server']
): ServerSurface['meta']['target'] {
  if (server.transport === 'stdio') {
    // stdio: command + args, NO env values
    const identity = [server.command, ...server.args].join(' ');
    return { transport: 'stdio', identity };
  } else {
    // http: origin + path, NO query string, NO headers
    const url = new URL(server.url);
    const identity = `${url.origin}${url.pathname}`;
    return { transport: 'http', identity };
  }
}

/**
 * Builds auth context from server config.
 * Detects auth from env vars or headers, computes fingerprint.
 * NEVER stores actual credential values.
 */
function buildAuthContext(
  server: Config['server'],
  serverIdentity: string
): ServerSurface['meta']['authContext'] {
  if (server.transport === 'stdio') {
    // Check for auth-related env vars
    const envKeys = Object.keys(server.env ?? {});
    const authKeys = envKeys.filter((key) =>
      /^(API_KEY|TOKEN|AUTH|SECRET|PASSWORD|CREDENTIAL)/i.test(key)
    );

    // Fingerprint first auth key found
    const firstKey = authKeys[0];
    if (firstKey === undefined) {
      return {
        kind: 'none',
        keys: [],
        fingerprint: null,
        label: null,
      };
    }

    const credential = server.env?.[firstKey];
    const fingerprint = fingerprintCredential(credential, serverIdentity);

    return {
      kind: 'env',
      keys: authKeys,
      fingerprint,
      label: null, // TODO: allow user to specify via config
    };
  } else {
    // HTTP: check for Authorization or other auth headers
    const headerKeys = Object.keys(server.headers ?? {});
    const authKeys = headerKeys.filter((key) =>
      /^(authorization|x-api-key|x-auth|bearer)/i.test(key)
    );

    // Fingerprint first auth header found
    const firstKey = authKeys[0];
    if (firstKey === undefined) {
      return {
        kind: 'none',
        keys: [],
        fingerprint: null,
        label: null,
      };
    }

    const credential = server.headers?.[firstKey];
    const fingerprint = fingerprintCredential(credential, serverIdentity);

    return {
      kind: 'header',
      keys: authKeys,
      fingerprint,
      label: null, // TODO: allow user to specify via config
    };
  }
}

/**
 * Builds environment info from process.
 */
function buildEnvironment(): ServerSurface['meta']['environment'] {
  return {
    ci: Boolean(process.env.CI),
    nodeVersion: process.version,
    platform: process.platform,
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
  await writeFile(path, json, 'utf-8');
}

/**
 * Loads a server surface from a lockfile.
 * Supports both v1 (pre-M1) and v2 (M1+) lockfile formats.
 *
 * V1 lockfiles (no schemaVersion field) are loaded with default provenance values.
 * A warning is emitted recommending re-baseline to capture full provenance.
 */
export async function loadLockfile(path: string): Promise<ServerSurface> {
  const content = await readFile(path, 'utf-8');
  const parsed = JSON.parse(content) as Partial<ServerSurface>;

  // Detect v1 lockfile (no schemaVersion or schemaVersion !== 2)
  const schemaVersion = parsed.meta?.schemaVersion;
  const isV1 = !schemaVersion || schemaVersion !== 2;

  if (isV1) {
    // V1 lockfile detected - migrate to v2 format with defaults
    console.warn(
      'Warning: Loading v1 lockfile (pre-M1). Provenance fields unavailable.\n' +
        '         Recommend running "mcpward baseline" to update to v2 format.'
    );

    // Migrate v1 → v2 with defensive defaults
    const v1Surface = parsed as ServerSurface;

    // Ensure meta exists
    if (!v1Surface.meta) {
      throw new Error('Invalid lockfile: missing meta field');
    }

    // Fill missing v2 fields with defaults
    const migratedSurface: ServerSurface = {
      ...v1Surface,
      meta: {
        schemaVersion: 2, // Mark as migrated
        mcpwardVersion: v1Surface.meta.mcpwardVersion || 'unknown',
        canonicalVersion: v1Surface.meta.canonicalVersion ?? 0, // v1 had no canonicalization
        capturedAt: v1Surface.meta.capturedAt || new Date(0).toISOString(),
        serverName: v1Surface.meta.serverName || 'unknown',
        serverVersion: v1Surface.meta.serverVersion || 'unknown',
        // V1 lockfiles have no provenance - use unknown defaults
        target: {
          transport: 'stdio',
          identity: 'unknown (v1 lockfile)',
        },
        authContext: {
          kind: 'unknown',
          keys: [],
          fingerprint: null,
          label: null,
        },
        environment: {
          ci: false,
          nodeVersion: 'unknown',
          platform: 'unknown',
        },
      },
    };

    // Defensively canonicalize tool surfaces (v1 may not be canonical)
    for (const toolName of Object.keys(migratedSurface.tools)) {
      const tool = migratedSurface.tools[toolName] as ToolSurface | undefined;
      if (tool) {
        // Canonicalize schemas
        tool.inputSchema = canonicalizeSchema(tool.inputSchema);
        tool.outputSchema = canonicalizeSchema(tool.outputSchema);
        // V1 had no description storage
        if (!('description' in tool)) {
          (tool as ToolSurface & { description?: string | null }).description =
            null;
        }
      }
    }

    return migratedSurface;
  }

  // V2 lockfile - return as-is (already in correct format)
  return parsed as ServerSurface;
}
