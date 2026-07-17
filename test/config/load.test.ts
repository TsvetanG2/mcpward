import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config/load.js';

describe('loadConfig', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `mcpward-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('loads a valid stdio config', async () => {
    const configPath = join(testDir, 'mcpward.yaml');
    await writeFile(
      configPath,
      `
server:
  transport: stdio
  command: node
  args: ["server.js"]
  env:
    LOG_LEVEL: debug
`
    );

    const config = await loadConfig(configPath);

    expect(config.server.transport).toBe('stdio');
    if (config.server.transport === 'stdio') {
      expect(config.server.command).toBe('node');
      expect(config.server.args).toEqual(['server.js']);
      expect(config.server.env).toEqual({ LOG_LEVEL: 'debug' });
    }
  });

  it('loads a valid http config', async () => {
    const configPath = join(testDir, 'mcpward.yaml');
    await writeFile(
      configPath,
      `
server:
  transport: http
  url: https://example.com/mcp
  headers:
    Authorization: Bearer token123
`
    );

    const config = await loadConfig(configPath);

    expect(config.server.transport).toBe('http');
    if (config.server.transport === 'http') {
      expect(config.server.url).toBe('https://example.com/mcp');
      expect(config.server.headers).toEqual({ Authorization: 'Bearer token123' });
    }
  });

  it('applies default values for args and env', async () => {
    const configPath = join(testDir, 'mcpward.yaml');
    await writeFile(
      configPath,
      `
server:
  transport: stdio
  command: node
`
    );

    const config = await loadConfig(configPath);

    expect(config.server.transport).toBe('stdio');
    if (config.server.transport === 'stdio') {
      expect(config.server.args).toEqual([]);
      expect(config.server.env).toEqual({});
    }
    expect(config.suites).toEqual([]);
  });

  it('applies default values for checks when checks block is present', async () => {
    const configPath = join(testDir, 'mcpward.yaml');
    await writeFile(
      configPath,
      `
server:
  transport: stdio
  command: node
checks: {}
`
    );

    const config = await loadConfig(configPath);

    expect(config.checks?.compliance).toBe(true);
    expect(config.checks?.schema).toBe(true);
    expect(config.checks?.security).toBe(true);
  });

  it('interpolates environment variables', async () => {
    const configPath = join(testDir, 'mcpward.yaml');
    await writeFile(
      configPath,
      `
server:
  transport: http
  url: https://example.com/mcp
  headers:
    Authorization: "Bearer \${TEST_TOKEN}"
`
    );

    process.env.TEST_TOKEN = 'secret123';
    try {
      const config = await loadConfig(configPath);
      if (config.server.transport === 'http') {
        expect(config.server.headers).toEqual({ Authorization: 'Bearer secret123' });
      }
    } finally {
      delete process.env.TEST_TOKEN;
    }
  });

  it('throws on missing environment variable', async () => {
    const configPath = join(testDir, 'mcpward.yaml');
    await writeFile(
      configPath,
      `
server:
  transport: http
  url: https://example.com/mcp
  headers:
    Authorization: "Bearer \${MISSING_VAR}"
`
    );

    delete process.env.MISSING_VAR;

    await expect(loadConfig(configPath)).rejects.toThrow(
      'Environment variable "MISSING_VAR" is not set'
    );
  });

  it('throws on missing config file', async () => {
    await expect(loadConfig('/nonexistent/mcpward.yaml')).rejects.toThrow(
      'Config file not found'
    );
  });

  it('throws on invalid transport', async () => {
    const configPath = join(testDir, 'mcpward.yaml');
    await writeFile(
      configPath,
      `
server:
  transport: invalid
  command: node
`
    );

    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  it('throws on missing required field', async () => {
    const configPath = join(testDir, 'mcpward.yaml');
    await writeFile(
      configPath,
      `
server:
  transport: stdio
`
    );

    await expect(loadConfig(configPath)).rejects.toThrow('Invalid config');
  });

  it('loads drift config with fail_on options', async () => {
    const configPath = join(testDir, 'mcpward.yaml');
    await writeFile(
      configPath,
      `
server:
  transport: stdio
  command: node
checks:
  drift:
    baseline: ./custom.lock.json
    fail_on:
      - tool_removed
      - description_changed
`
    );

    const config = await loadConfig(configPath);

    expect(config.checks?.drift?.baseline).toBe('./custom.lock.json');
    expect(config.checks?.drift?.fail_on).toEqual(['tool_removed', 'description_changed']);
  });

  it('loads behavioral test suites', async () => {
    const configPath = join(testDir, 'mcpward.yaml');
    await writeFile(
      configPath,
      `
server:
  transport: stdio
  command: node
suites:
  - tool: read_file
    cases:
      - name: reads existing file
        args:
          path: /tmp/test.txt
        expect:
          tool_is_error: false
      - name: missing file returns error
        args:
          path: /nonexistent
        expect:
          tool_is_error: true
`
    );

    const config = await loadConfig(configPath);

    expect(config.suites).toHaveLength(1);
    expect(config.suites[0]?.tool).toBe('read_file');
    expect(config.suites[0]?.cases).toHaveLength(2);
    expect(config.suites[0]?.cases[0]?.name).toBe('reads existing file');
    expect(config.suites[0]?.cases[0]?.expect?.tool_is_error).toBe(false);
  });
});
