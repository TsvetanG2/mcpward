#!/usr/bin/env node
/**
 * drift/output-v1 fixture — baseline for output shape drift (M3).
 * See ../output-common.ts for the ground-truth table.
 */

import { startOutputDriftServer, feedOutput, helloOutput } from '../output-common.js';

startOutputDriftServer('1.0.0', (tool, callIndex, args) => {
  switch (tool) {
    case 'get_status':
      return {
        structuredContent: {
          status: 'ok',
          uptime: Math.floor(Math.random() * 100000),
          checkedAt: new Date().toISOString(),
        },
      };
    case 'get_profile':
      return {
        text: JSON.stringify({ id: `acct-${callIndex}`, owner: { id: 7, name: 'Ada' } }),
      };
    case 'get_metrics':
      return { structuredContent: { count: 10 + callIndex, p50: Math.random() * 20 } };
    case 'get_feed':
      return feedOutput(callIndex);
    case 'say_hello':
      return helloOutput();
    case 'lookup':
      return { structuredContent: { id: String(args.id ?? ''), value: 42 } };
    case 'wipe_data':
      return { structuredContent: { ok: true } };
    default:
      return { text: `unknown tool ${tool}` };
  }
});
