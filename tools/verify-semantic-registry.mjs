import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadSemanticRegistry,
  validateSemanticRegistry,
} from '../src/catalogue/semantic-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const inventoryFile = path.join(ROOT, 'library', 'asset-inventory.json');

const registry = loadSemanticRegistry();
const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
const result = validateSemanticRegistry(registry, inventory);

for (const warning of result.warnings) console.warn(`warning: ${warning}`);
if (!result.valid) {
  for (const error of result.errors) console.error(`error: ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `semantic registry valid: ${registry.mappings.length} mappings, ` +
    `${result.referencedAssets} validated assets, ${result.warnings.length} warnings`,
  );
}
