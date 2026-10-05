/**
 * Regenerates schemas/config.v1.schema.json from the zod config schema.
 *
 *   pnpm run schemas
 *
 * The report and lockfile schemas are hand-written (they describe TypeScript interfaces);
 * tests validate real mcpward output against them.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configJsonSchema, CONFIG_SCHEMA_VERSION } from '../src/config/json-schema.js';

const out = join(process.cwd(), 'schemas', `config.v${CONFIG_SCHEMA_VERSION}.schema.json`);
writeFileSync(out, JSON.stringify(configJsonSchema(), null, 2) + '\n');
console.log(`wrote ${out}`);
