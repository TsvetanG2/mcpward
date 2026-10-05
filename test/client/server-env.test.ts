/**
 * The server under test is untrusted: mcpward's own credentials must not reach it.
 * (When the action runs with pr-comment, MCPWARD_GITHUB_TOKEN holds a write-capable token.)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { connect, serverEnv } from '../../src/client/connect.js';
import { testConfig } from '../helpers/config.js';

const ENV_ECHO = join(process.cwd(), 'fixtures', 'env-echo-server', 'index.ts');

async function seenByServer(name: string, env: Record<string, string> = {}): Promise<string> {
  const connection = await connect(
    testConfig({ server: { transport: 'stdio', command: 'npx', args: ['tsx', ENV_ECHO], env } })
  );
  try {
    const result = (await connection.callTool({ name: 'read_env', arguments: { name } })) as {
      content: { text: string }[];
    };
    return result.content[0]?.text ?? '';
  } finally {
    await connection.close();
  }
}

describe('stdio server environment', () => {
  const saved = {
    MCPWARD_GITHUB_TOKEN: process.env.MCPWARD_GITHUB_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  it('never passes mcpward credentials to the server under test', async () => {
    process.env.MCPWARD_GITHUB_TOKEN = 'ghs_pr_comment_token';
    process.env.GITHUB_TOKEN = 'ghs_workflow_token';
    expect(await seenByServer('MCPWARD_GITHUB_TOKEN')).toBe('<unset>');
    expect(await seenByServer('GITHUB_TOKEN')).toBe('<unset>');
  }, 30000);

  it('still passes ordinary inherited variables and explicit server.env', async () => {
    process.env.GITHUB_TOKEN = 'ghs_workflow_token';
    expect(await seenByServer('PATH')).not.toBe('<unset>');
    // A deliberate, explicit choice in the config is honored (e.g. testing a GitHub MCP server)
    expect(await seenByServer('GITHUB_TOKEN', { GITHUB_TOKEN: 'explicitly-configured' })).toBe(
      'explicitly-configured'
    );
  }, 30000);

  it('serverEnv withholds credentials case-insensitively (Windows env names)', () => {
    const env = serverEnv({ mcpward_github_token: 'x', Github_Token: 'y', HOME: '/h' }, {});
    expect(env).toEqual({ HOME: '/h' });
  });
});
