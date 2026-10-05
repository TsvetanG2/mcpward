#!/usr/bin/env node
/**
 * drift/output-v2 fixture — output shape changed, input schemas did not (M3).
 * See ../output-common.ts for the ground-truth table.
 */

import { startOutputDriftServer, feedOutput, helloOutput } from '../output-common.js';

startOutputDriftServer('2.0.0', (tool, callIndex, args) => {
  switch (tool) {
    case 'get_status':
      // `uptime` removed → breaking
      return {
        structuredContent: { status: 'ok', checkedAt: new Date().toISOString() },
      };
    case 'get_profile':
      // `owner` object → string → breaking
      return { text: JSON.stringify({ id: `acct-${callIndex}`, owner: 'Ada' }) };
    case 'get_metrics':
      // `p99` added → non-breaking
      return {
        structuredContent: {
          count: 10 + callIndex,
          p50: Math.random() * 20,
          p99: Math.random() * 90,
        },
      };
    case 'get_feed':
      return feedOutput(callIndex);
    case 'say_hello':
      return helloOutput();
    case 'lookup':
      // `value` removed → breaking, but only visible when allowlisted with args
      return { structuredContent: { id: String(args.id ?? '') } };
    case 'wipe_data':
      // Shape changes so that calling it would produce a finding
      return { structuredContent: { ok: 'yes', deleted: 5 } };
    default:
      return { text: `unknown tool ${tool}` };
  }
});
