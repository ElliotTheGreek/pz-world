import { mkdirSync, writeFileSync } from 'node:fs';

import {
  rasterGoldenDocument,
  terrainBoundaryGolden,
} from '../test/fixtures/road-surface-cases.js';

const output = new URL('../test/goldens/', import.meta.url);
mkdirSync(output, { recursive: true });

function write(name, value) {
  const url = new URL(name, output);
  writeFileSync(url, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${url.pathname}`);
}

write('road-surfaces.json', rasterGoldenDocument());
write('terrain-boundaries.json', terrainBoundaryGolden());
