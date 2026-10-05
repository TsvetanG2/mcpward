#!/usr/bin/env node
/** drift/schema-v2 fixture (M6.3). Ground truth: ../schema-common.ts */

import { startSchemaDriftServer } from '../schema-common.js';

startSchemaDriftServer('v2');
