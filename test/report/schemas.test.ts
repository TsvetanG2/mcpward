/**
 * Published JSON Schemas (M7) validate REAL mcpward output, and can fail.
 *
 * schemas/report.v1, schemas/lockfile.v2 are hand-written; schemas/config.v1 is generated from
 * the zod schema and must stay in sync (`pnpm run schemas`).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { configJsonSchema } from '../../src/config/json-schema.js';
import { ConfigSchema } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/commands/init.js';
import { runCommand } from '../../src/commands/run.js';
import { connect } from '../../src/client/connect.js';
import { captureServerSurface } from '../../src/surface/index.js';
import { testConfig } from '../helpers/config.js';

type ValidateFn = ((data: unknown) => boolean) & { errors?: unknown };
interface AjvLike {
  compile: (schema: unknown) => ValidateFn;
}

const ROOT = process.cwd();
const FIXTURES = join(ROOT, 'fixtures');
const readSchema = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, 'schemas', name), 'utf-8')) as unknown;

function validator(name: string): ValidateFn {
  const Ajv = ((Ajv2020Module as unknown as { default?: unknown }).default ??
    Ajv2020Module) as new (opts: object) => AjvLike;
  const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
    addFormatsModule) as (ajv: AjvLike) => void;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(readSchema(name));
}

const expectValid = (validate: ValidateFn, data: unknown) => {
  const ok = validate(data);
  expect(validate.errors ?? null, JSON.stringify(validate.errors)).toBeNull();
  expect(ok).toBe(true);
};

describe('config schema', () => {
  it('committed schemas/config.v1.schema.json is up to date with the zod schema', () => {
    expect(readSchema('config.v1.schema.json')).toEqual(configJsonSchema());
  });

  it('accepts the shipped example and the init template', () => {
    const validate = validator('config.v1.schema.json');
    expectValid(validate, parseYaml(readFileSync(join(ROOT, 'examples', 'mcpward.yaml'), 'utf-8')));
    expectValid(validate, parseYaml(DEFAULT_CONFIG));
  });

  it('server.url matches the parser: http(s) or an ${ENV} placeholder, nothing else', () => {
    const validate = validator('config.v1.schema.json');
    const http = (url: string) => ({ server: { transport: 'http', url } });
    expect(validate(http('https://mcp.example.com/mcp'))).toBe(true);
    expect(validate(http('http://localhost:3000/mcp'))).toBe(true);
    // expanded by loadConfig before validation — must not be flagged in the editor
    expect(validate(http('${MCP_URL}'))).toBe(true);
    expect(validate(http('https://${MCP_HOST}/mcp'))).toBe(true);
    // rejected by the parser — must be rejected by the published schema too
    expect(validate(http('file:///etc/passwd'))).toBe(false);
    expect(validate(http('ftp://example.com/mcp'))).toBe(false);
    // a fixed unsupported scheme can never become valid, placeholder or not
    expect(validate(http('ftp://${MCP_HOST}/mcp'))).toBe(false);
    expect(validate(http('file://${MCP_PATH}'))).toBe(false);
  });

  it.each([
    'https://mcp.example.com/mcp',
    'http://localhost:3000/mcp',
    'HTTPS://example.com/mcp', // scheme case — the parser normalizes it
    'https://example.com:abc/mcp', // non-numeric port
    'https://exa mple.com/mcp',
    'http://[::1]:8080/mcp', // IPv6 literal
    'https://user:pass@example.com/mcp', // userinfo
    'https://example.com:65535/mcp',
    'https://example.com:99999/mcp', // port out of range
    'https://example.com?mode=ci',
    'https://example.com',
    'https://bücher.example/mcp', // internationalized hostname
    'https://example.com:00080/mcp', // leading zeros in the port
    'file:///etc/passwd',
    'ftp://example.com/mcp',
    'mcp.example.com/mcp',
  ])('server.url %j: the published schema and the parser agree', (url) => {
    const validate = validator('config.v1.schema.json');
    const config = { server: { transport: 'http', url } };
    expect(validate(config)).toBe(ConfigSchema.safeParse(config).success);
  });

  it('NEGATIVE: rejects an unknown transport and an invalid fail_on', () => {
    const validate = validator('config.v1.schema.json');
    expect(validate({ server: { transport: 'ftp', command: 'x' } })).toBe(false);
    expect(
      validate({
        server: { transport: 'stdio', command: 'x' },
        checks: { drift: { fail_on: 'critical' } },
      })
    ).toBe(false);
  });
});

describe('report schema', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpward-schema-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function realReport(fixture: string): Promise<unknown> {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = join(dir, `${fixture}.json`);
    try {
      await runCommand(
        testConfig({
          server: {
            transport: 'stdio',
            command: 'npx',
            args: ['tsx', join(FIXTURES, fixture, 'index.ts')],
          },
        }),
        { config: 'mcpward.yaml', reporter: 'json', out }
      );
    } finally {
      vi.restoreAllMocks();
    }
    return JSON.parse(await readFile(out, 'utf-8'));
  }

  it.each(['good-server', 'poisoned-server', 'collision-server'])(
    'a real `run --reporter json` report against %s validates',
    async (fixture) => {
      const report = (await realReport(fixture)) as { schemaVersion: number; results: unknown[] };
      expect(report.schemaVersion).toBe(1);
      expect(report.results.length).toBeGreaterThan(0);
      expectValid(validator('report.v1.schema.json'), report);
    },
    60000
  );

  it('NEGATIVE: rejects a report without schemaVersion or with an unknown status', async () => {
    const validate = validator('report.v1.schema.json');
    const report = (await realReport('good-server')) as Record<string, unknown> & {
      results: Record<string, unknown>[];
    };

    const noVersion = { ...report };
    delete noVersion.schemaVersion;
    expect(validate(noVersion)).toBe(false);

    const badStatus = { ...report, results: [{ ...report.results[0], status: 'ok' }] };
    expect(validate(badStatus)).toBe(false);
  }, 60000);
});

describe('lockfile schema', () => {
  async function capture(fixture: string, output = false): Promise<unknown> {
    const cfg = testConfig({
      server: { transport: 'stdio', command: 'npx', args: ['tsx', join(FIXTURES, fixture)] },
      checks: { drift: output ? { output: { enabled: true, shape_samples: 2 } } : {} },
    });
    const connection = await connect(cfg);
    try {
      // Round-trip through JSON exactly as saveLockfile writes it
      return JSON.parse(JSON.stringify(await captureServerSurface(connection, cfg)));
    } finally {
      await connection.close();
    }
  }

  it('a real baseline validates (including inferred output shapes)', async () => {
    const validate = validator('lockfile.v2.schema.json');
    expectValid(validate, await capture('drift/v1/index.ts'));
    const withShapes = (await capture('drift/output-v1/index.ts', true)) as {
      tools: Record<string, { outputShape?: unknown }>;
    };
    expect(Object.values(withShapes.tools).some((t) => t.outputShape)).toBe(true);
    expectValid(validate, withShapes);
  }, 60000);

  it('NEGATIVE: rejects a malformed description hash and a credential-shaped fingerprint', async () => {
    const validate = validator('lockfile.v2.schema.json');
    const lock = (await capture('drift/v1/index.ts')) as {
      tools: Record<string, { descriptionHash: string }>;
      meta: { authContext: { fingerprint: string | null } };
    };
    const first = Object.keys(lock.tools)[0] ?? '';

    const badHash = structuredClone(lock);
    const tool = badHash.tools[first];
    if (tool) tool.descriptionHash = 'md5:abc';
    expect(validate(badHash)).toBe(false);

    const leaky = structuredClone(lock);
    leaky.meta.authContext.fingerprint = 'sk-live-THIS-IS-A-REAL-SECRET';
    expect(validate(leaky)).toBe(false);
  }, 60000);
});
