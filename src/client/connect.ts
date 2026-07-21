import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { Config, StdioTransport, HttpTransport, ResolvedTimeoutConfig } from '../config/schema.js';

/** Default timeout values in milliseconds */
const DEFAULT_TIMEOUTS = {
  connect_ms: 10000,
  call_ms: 30000,
  run_ms: 300000,
};

export interface McpConnection {
  client: Client;
  protocolVersion: string;
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities: Record<string, unknown>;
  timeouts: ResolvedTimeoutConfig;
  close: () => Promise<void>;
}

/**
 * Wraps a promise with a timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout: ${message} (${ms}ms)`)), ms);
    }),
  ]);
}

/**
 * Merges environment variables, filtering out undefined values.
 */
function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value;
  }
  return result;
}

/**
 * Connects to an MCP server over stdio transport.
 */
async function connectStdio(
  config: StdioTransport,
  timeouts: ResolvedTimeoutConfig
): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: mergeEnv(process.env, config.env),
  });

  const client = new Client(
    {
      name: 'mcpward',
      version: '0.1.0',
    },
    {
      capabilities: {},
    }
  );

  // Connect with timeout
  await withTimeout(
    client.connect(transport),
    timeouts.connect_ms,
    'connection to server'
  );

  // Get server info from the initialization result
  const serverInfo = client.getServerVersion();
  const capabilities = client.getServerCapabilities();

  if (!serverInfo) {
    throw new Error('Server did not provide version information');
  }

  // The SDK handles version negotiation internally
  // If connection succeeds, the server supports LATEST_PROTOCOL_VERSION or newer
  return {
    client,
    protocolVersion: LATEST_PROTOCOL_VERSION,
    serverInfo: {
      name: serverInfo.name,
      version: serverInfo.version,
    },
    capabilities: capabilities ?? {},
    timeouts,
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Connects to an MCP server over HTTP transport (Streamable HTTP).
 */
async function connectHttp(
  config: HttpTransport,
  timeouts: ResolvedTimeoutConfig
): Promise<McpConnection> {
  const url = new URL(config.url);

  // Build headers with optional Authorization
  const headers: Record<string, string> = {};
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) {
      headers[key] = value;
    }
  }

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers,
    },
  });

  const client = new Client(
    {
      name: 'mcpward',
      version: '0.1.0',
    },
    {
      capabilities: {},
    }
  );

  // Connect with timeout
  await withTimeout(
    client.connect(transport),
    timeouts.connect_ms,
    'connection to server'
  );

  // Get server info from the initialization result
  const serverInfo = client.getServerVersion();
  const capabilities = client.getServerCapabilities();

  if (!serverInfo) {
    throw new Error('Server did not provide version information');
  }

  return {
    client,
    protocolVersion: LATEST_PROTOCOL_VERSION,
    serverInfo: {
      name: serverInfo.name,
      version: serverInfo.version,
    },
    capabilities: capabilities ?? {},
    timeouts,
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Connects to an MCP server using the configured transport.
 */
export async function connect(config: Config): Promise<McpConnection> {
  const timeouts: ResolvedTimeoutConfig = {
    connect_ms: config.timeouts?.connect_ms ?? DEFAULT_TIMEOUTS.connect_ms,
    call_ms: config.timeouts?.call_ms ?? DEFAULT_TIMEOUTS.call_ms,
    run_ms: config.timeouts?.run_ms ?? DEFAULT_TIMEOUTS.run_ms,
  };

  if (config.server.transport === 'stdio') {
    return connectStdio(config.server, timeouts);
  } else {
    return connectHttp(config.server, timeouts);
  }
}
