/**
 * Validates the example manifest against the schema with Ajv in strict mode, and checks that
 * manifests the spec forbids are rejected. Exits non-zero on any unexpected result.
 *
 *   npx tsx docs/rfc/risk-manifest-v1/validate.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

type Tool = Record<string, unknown> & { evidence: Record<string, unknown>[] };

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (file: string): unknown => JSON.parse(readFileSync(join(DIR, file), 'utf8'));
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(read('risk-manifest.v1.schema.json') as object);
const example = read('example.risk-manifest.json') as { tools: Tool[] };
const tool = (name: string): Tool => {
  const found = example.tools.find((t) => t.name === name);
  if (!found) throw new Error(`example has no tool ${name}`);
  return structuredClone(found);
};

let failures = 0;
const ok = validate(example);
console.log(`${ok ? 'valid   ' : 'INVALID '} example.risk-manifest.json`);
if (!ok) {
  failures++;
  console.log(validate.errors);
}

const mustReject: [string, Tool][] = [
  [
    'contractHash null without unhashableReason',
    { ...tool('get_comment'), unhashableReason: undefined },
  ],
  [
    'unhashable tool with a verdict other than unknown',
    {
      ...tool('get_comment'),
      verdict: { effect: 'read-only', openWorld: 'unknown', basis: 'annotation' },
    },
  ],
  [
    'contractHash string together with unhashableReason',
    { ...tool('delete_record'), unhashableReason: 'too-deep' },
  ],
  ['unknown unhashableReason', { ...tool('get_comment'), unhashableReason: 'too-long' }],
  [
    'no evidence with a verdict other than unknown',
    { ...tool('get_note'), verdict: { effect: 'read-only', openWorld: 'no', basis: 'heuristic' } },
  ],
  [
    'heuristic rule id without a namespace',
    {
      ...tool('delete_record'),
      evidence: [{ ...tool('delete_record').evidence[0], rule: 'name-verb' }],
    },
  ],
];
for (const [name, bad] of mustReject) {
  const accepted = validate({ ...example, tools: [JSON.parse(JSON.stringify(bad))] });
  if (accepted) failures++;
  console.log(`${accepted ? 'ACCEPTED' : 'rejected'} ${name}`);
}
process.exit(failures === 0 ? 0 : 1);
