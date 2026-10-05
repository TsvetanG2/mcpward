/**
 * stdio ↔ Streamable HTTP parity (SPEC v1 DoD).
 *
 * The same fixture server, reached over stdio and over HTTP, must produce identical
 * normalized results for every transport-independent check family. A difference here
 * means a check depends on the transport — a bug.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { mkdir, rm } from 'fs/promises';
import { spawn } from 'node:child_process';
import { connect, type McpConnection } from '../../src/client/connect.js';
import { runComplianceChecks } from '../../src/checks/compliance.js';
import { runSchemaChecks } from '../../src/checks/schema.js';
import { runSecurityChecks } from '../../src/checks/security.js';
import { runErrorContractChecks } from '../../src/checks/errors.js';
import { runDriftChecks } from '../../src/checks/drift.js';
import { captureServerSurface, saveLockfile } from '../../src/surface/index.js';
import type { CheckResult } from '../../src/report/model.js';
import type { Config } from '../../src/config/schema.js';

const FIXTURES = join(process.cwd(), 'fixtures');
const HTTP_HOST = join(FIXTURES, 'http-host.ts');
const TEMP_DIR = join(process.cwd(), 'test', '.temp-parity');

interface HttpFixture {
  url: string;
  stop: () => Promise<void>;
}

/** Starts fixtures/http-host.ts for a fixture and resolves once it is listening. */
async function startHttp(fixture: string, env: Record<string, string> = {}): Promise<HttpFixture> {
  // node:child_process, not execa: execa 10 requires Node >= 22 and we support Node 20
  const proc = spawn(process.execPath, ['--import', 'tsx', HTTP_HOST, fixture], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error(`http-host did not start for ${fixture}`)),
      20000
    );
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /LISTENING (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    void exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`http-host exited early: ${stderr}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stop: async () => {
      proc.kill();
      await exited;
    },
  };
}

const stdioConfig = (fixture: string, checks: Config['checks'] = {}): Config => ({
  server: { transport: 'stdio', command: 'npx', args: ['tsx', fixture], env: {} },
  checks,
  suites: [],
});

const httpConfig = (
  url: string,
  checks: Config['checks'] = {},
  headers: Record<string, string> = {}
): Config => ({
  server: { transport: 'http', url, headers },
  checks,
  suites: [],
});

async function runFamilies(config: Config): Promise<CheckResult[]> {
  const connection: McpConnection = await connect(config);
  try {
    return [
      ...(await runComplianceChecks({ connection, config })),
      ...(await runSchemaChecks({ connection })),
      ...(await runSecurityChecks({ connection })),
      ...(await runErrorContractChecks({ connection })),
    ];
  } finally {
    await connection.close();
  }
}

/** Transport-independent view of a result. */
const normalize = (results: CheckResult[]) =>
  results
    .map((r) => ({
      id: r.id,
      family: r.family,
      status: r.status,
      severity: r.severity,
      location: r.location,
      message: r.message,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('stdio ↔ HTTP parity', () => {
  beforeAll(async () => {
    await mkdir(TEMP_DIR, { recursive: true });
  });
  afterAll(async () => {
    await rm(TEMP_DIR, { recursive: true, force: true });
  });

  it.each(['good-server', 'poisoned-server', 'malformed-server', 'error-contract-server'])(
    '%s produces identical results over both transports',
    async (name) => {
      const fixture = join(FIXTURES, name, 'index.ts');
      const http = await startHttp(fixture);
      try {
        const viaStdio = normalize(await runFamilies(stdioConfig(fixture)));
        const viaHttp = normalize(await runFamilies(httpConfig(http.url)));
        expect(viaStdio.length).toBeGreaterThan(0);
        expect(viaHttp).toEqual(viaStdio);
      } finally {
        await http.stop();
      }
    },
    60000
  );

  it('good-server stays clean over HTTP (zero false positives)', async () => {
    const http = await startHttp(join(FIXTURES, 'good-server', 'index.ts'));
    try {
      const failures = (await runFamilies(httpConfig(http.url))).filter((r) => r.status === 'fail');
      expect(failures).toEqual([]);
    } finally {
      await http.stop();
    }
  }, 60000);

  it('drift: a stdio baseline diffed over HTTP classifies like stdio', async () => {
    const baseline = join(TEMP_DIR, 'parity.lock.json');
    const v1 = join(FIXTURES, 'drift', 'v1', 'index.ts');
    const v2 = join(FIXTURES, 'drift', 'v2', 'index.ts');
    const drift = { baseline, fail_on: 'medium' as const, full_text: true, severity: {} };

    const base = await connect(stdioConfig(v1));
    try {
      await saveLockfile(await captureServerSurface(base, stdioConfig(v1)), baseline);
    } finally {
      await base.close();
    }

    const runDrift = async (config: Config) => {
      const connection = await connect(config);
      try {
        return await runDriftChecks({
          connection,
          fullConfig: config,
          config: config.checks?.drift,
        });
      } finally {
        await connection.close();
      }
    };

    const http = await startHttp(v2);
    try {
      const viaStdio = normalize(await runDrift(stdioConfig(v2, { drift })));
      const viaHttp = normalize(await runDrift(httpConfig(http.url, { drift })));
      expect(viaStdio.some((r) => r.id === 'drift/description_changed')).toBe(true);
      expect(viaHttp).toEqual(viaStdio);
    } finally {
      await http.stop();
    }
  }, 60000);

  it('reports the negotiated protocol version, identical on both transports', async () => {
    const fixture = join(FIXTURES, 'good-server', 'index.ts');
    const http = await startHttp(fixture);
    try {
      const a = await connect(stdioConfig(fixture));
      const b = await connect(httpConfig(http.url));
      try {
        expect(a.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(b.protocolVersion).toBe(a.protocolVersion);
      } finally {
        await a.close();
        await b.close();
      }
    } finally {
      await http.stop();
    }
  }, 60000);

  it('sends configured headers (bearer auth) over HTTP', async () => {
    const fixture = join(FIXTURES, 'good-server', 'index.ts');
    const http = await startHttp(fixture, { MCPWARD_FIXTURE_TOKEN: 's3cret-token' });
    try {
      await expect(connect(httpConfig(http.url))).rejects.toThrow();
      const ok = await connect(httpConfig(http.url, {}, { Authorization: 'Bearer s3cret-token' }));
      await ok.close();
    } finally {
      await http.stop();
    }
  }, 60000);
});
