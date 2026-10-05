#!/usr/bin/env node
/**
 * Serves any stdio fixture over Streamable HTTP, for stdio↔HTTP parity tests.
 *
 *   tsx fixtures/http-host.ts fixtures/good-server/index.ts
 *
 * The fixture module must `export const server` and skip its own stdio startup when
 * MCPWARD_FIXTURE_NO_STDIO is set. Binds 127.0.0.1 on a random port and prints
 * `LISTENING <port>` on stdout once ready. Endpoint: /mcp
 *
 * If MCPWARD_FIXTURE_TOKEN is set, requests must carry `Authorization: Bearer <token>`.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

process.env.MCPWARD_FIXTURE_NO_STDIO = '1';

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error('usage: http-host.ts <fixture-module>');
  process.exit(2);
}

const mod = (await import(pathToFileURL(resolve(fixturePath)).href)) as { server?: Server };
if (!mod.server) {
  console.error(`${fixturePath} does not export "server"`);
  process.exit(2);
}

const token = process.env.MCPWARD_FIXTURE_TOKEN;
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await mod.server.connect(transport);

const http = createServer((req, res) => {
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end('unauthorized');
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    let body: unknown;
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        res.writeHead(400).end('invalid JSON');
        return;
      }
    }
    transport.handleRequest(req, res, body).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
});

http.listen(0, '127.0.0.1', () => {
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  console.log(`LISTENING ${port}`);
});
