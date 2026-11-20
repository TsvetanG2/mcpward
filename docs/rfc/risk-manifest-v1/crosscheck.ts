/**
 * Cross-checks the mcp-tool-contract hash: runs the Python reference (contract_hash.py) and
 * an independent TypeScript implementation built on mcpward's own canonicalization
 * (src/surface/canonical.ts) over every vector, and fails if they disagree.
 *
 *   npx tsx docs/rfc/risk-manifest-v1/crosscheck.ts
 *   PYTHON="py -3" npx tsx docs/rfc/risk-manifest-v1/crosscheck.ts   (Windows)
 *
 * The TypeScript side works on parsed data, like mcpward behind the MCP SDK, so it cannot
 * detect duplicate keys; for those vectors it reports that instead of a hash. Numbers are
 * the exception: JSON.parse turns 9007199254740993 into 9007199254740992, so the number
 * rules are checked on the raw text with a small JSON number scanner. mcpward cannot do
 * this today (it never sees the raw message).
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeDescription, canonicalizeSchema } from '../../../src/surface/canonical.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const NOT_DETECTABLE = 'not detectable from parsed input';

const TEXT_MEMBERS = new Set(['description', 'title']);
const DATA_MEMBERS = new Set(['default', 'const', 'enum', 'examples']);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function setOwn(obj: Record<string, Json>, key: string, value: Json): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function* strings(value: Json): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      yield k;
      yield* strings(v);
    }
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Every number literal in raw JSON text, with strings skipped. Assumes valid JSON. */
function* numberLiterals(text: string): Generator<{ literal: string; integer: boolean }> {
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m) continue;
      yield { literal: m[0], integer: m[1] === undefined && m[2] === undefined };
      i += m[0].length - 1;
    }
  }
}

/** Number rules on the raw text: non-finite first, then precision (the spec's order). */
function numberReason(text: string): string | null {
  const literals = [...numberLiterals(text)];
  const abs = (s: string) => (s.startsWith('-') ? s.slice(1) : s);
  if (literals.some((n) => !n.integer && !Number.isFinite(Number(n.literal)))) {
    return 'non-finite-number';
  }
  if (literals.some((n) => n.integer && BigInt(abs(n.literal)) > MAX_SAFE)) {
    return 'number-precision';
  }
  return null;
}

/** Glue: description/title string members become canonical text; data members stay as they are. */
function canonicalText(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonicalText);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(value)) {
    if (DATA_MEMBERS.has(k)) setOwn(out, k, v);
    else if (TEXT_MEMBERS.has(k) && typeof v === 'string')
      setOwn(out, k, canonicalizeDescription(v));
    else setOwn(out, k, canonicalText(v));
  }
  return out;
}

/**
 * Glue: RFC 8785 serialization. mcpward's canonicalJson relies on JSON.stringify, which emits
 * integer-like keys ("9", "10") in numeric order before all others, whatever the insertion
 * order; RFC 8785 sorts every key by UTF-16 code units ("10" < "1a" < "9"). Numbers and
 * strings are serialized by JSON.stringify, which follows ECMAScript as RFC 8785 requires.
 */
function jcs(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k] as Json)}`).join(',')}}`;
}

function tsResult(text: string): string {
  const tool = JSON.parse(text) as Record<string, Json>;
  // Unhashable rules, in the spec's order (duplicate-key cannot be seen here).
  if ([...strings(tool)].some((s) => LONE_SURROGATE.test(s))) return 'unhashable: lone-surrogate';
  const numbers = numberReason(text);
  if (numbers) return `unhashable: ${numbers}`;

  let inputSchema: Json;
  try {
    inputSchema = canonicalizeSchema((tool.inputSchema ?? {}) as never) as Json;
  } catch (error) {
    if (String(error).includes('maximum depth')) return 'unhashable: too-deep';
    throw error;
  }
  const annotations = canonicalizeSchema((tool.annotations ?? {}) as never) as Json;

  const canonical = {
    name: String(tool.name).normalize('NFC'),
    title: canonicalizeDescription(tool.title as string | undefined),
    description: canonicalizeDescription(tool.description as string | undefined),
    inputSchema: canonicalText(inputSchema),
    annotations: canonicalText(annotations),
  };
  return 'sha256:' + createHash('sha256').update(jcs(canonical), 'utf8').digest('hex');
}

function pyResult(file: string): string {
  const [cmd = 'python3', ...args] = (process.env.PYTHON ?? 'python3').split(' ');
  const out = execFileSync(cmd, [...args, '-I', join(DIR, 'contract_hash.py'), file], {
    encoding: 'utf8',
  });
  return out.trimEnd().split('\n').pop() ?? '';
}

const vectors = readdirSync(join(DIR, 'vectors')).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
let failures = 0;
for (const name of vectors) {
  const file = join(DIR, 'vectors', name);
  const py = pyResult(file);
  let ts = tsResult(readFileSync(file, 'utf8'));
  let verdict = ts === py ? 'agree' : 'DISAGREE';
  if (py === 'unhashable: duplicate-key') {
    ts = `${NOT_DETECTABLE} (would be ${ts})`;
    verdict = 'expected limitation';
  }
  if (verdict === 'DISAGREE') failures++;
  console.log(`${name}\n  python:     ${py}\n  typescript: ${ts}\n  ${verdict}`);
}
console.log(failures === 0 ? '\nAll vectors agree.' : `\n${failures} vector(s) disagree.`);
process.exit(failures === 0 ? 0 : 1);
