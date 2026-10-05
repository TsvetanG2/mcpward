import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type {
  Config,
  StdioTransport,
  HttpTransport,
  ResolvedTimeoutConfig,
} from '../config/schema.js';
import { MCPWARD_VERSION } from '../version.js';

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
  /** Call a tool with the configured timeout */
  callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
}

/**
 * Wraps a promise with a timeout. The timer is always cleared, so a settled call never
 * keeps the event loop alive for the rest of the timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${message} (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * mcpward's own credentials. The server under test is UNTRUSTED, so these are never
 * inherited by it — a stdio server could otherwise read the write-capable PR-comment token.
 * A user can still pass one deliberately through `server.env` in the config.
 */
export const WITHHELD_FROM_SERVER = ['MCPWARD_GITHUB_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * Builds the stdio server's environment: the inherited environment minus mcpward's own
 * credentials, then the config's explicit `server.env` (which always wins).
 */
export function serverEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>
): Record<string, string> {
  const withheld = new Set<string>(WITHHELD_FROM_SERVER);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !withheld.has(key.toUpperCase())) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value;
  }
  return result;
}

/**
 * Runs the initialize handshake over any transport and builds the connection.
 *
 * Shared by stdio and HTTP so both transports produce identical connection objects —
 * the precondition for stdio↔HTTP result parity.
 */
async function connectTransport(
  transport: Transport,
  timeouts: ResolvedTimeoutConfig
): Promise<McpConnection> {
  // Record the protocol version the server actually negotiated. The SDK hands it to the
  // transport via setProtocolVersion after initialize; we read it from there rather than
  // assuming LATEST_PROTOCOL_VERSION (a server may legitimately negotiate an older one).
  let negotiatedVersion: string | undefined;
  const original = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (version: string) => {
    negotiatedVersion = version;
    original?.(version);
  };

  const client = new Client(
    {
      name: 'mcpward',
      version: MCPWARD_VERSION,
    },
    {
      capabilities: {},
    }
  );

  await withTimeout(client.connect(transport), timeouts.connect_ms, 'connection to server');

  const serverInfo = client.getServerVersion();
  const capabilities = client.getServerCapabilities();

  if (!serverInfo) {
    await client.close();
    throw new Error('Server did not provide version information');
  }

  return {
    client,
    protocolVersion: negotiatedVersion ?? LATEST_PROTOCOL_VERSION,
    serverInfo: {
      name: serverInfo.name,
      version: serverInfo.version,
    },
    capabilities: capabilities ?? {},
    timeouts,
    close: async () => {
      await client.close();
    },
    callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => {
      return withTimeout(client.callTool(params), timeouts.call_ms, `tool call "${params.name}"`);
    },
  };
}

/**
 * Connects to an MCP server over stdio transport.
 */
function connectStdio(
  config: StdioTransport,
  timeouts: ResolvedTimeoutConfig
): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: serverEnv(process.env, config.env),
  });
  return connectTransport(transport, timeouts);
}

/**
 * Connects to an MCP server over HTTP transport (Streamable HTTP).
 */
function connectHttp(
  config: HttpTransport,
  timeouts: ResolvedTimeoutConfig
): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: { ...config.headers },
    },
  });
  return connectTransport(transport, timeouts);
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
