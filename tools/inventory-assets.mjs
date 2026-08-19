#!/usr/bin/env node
/** Generate searchable asset coverage from the committed vanilla evidence. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAssetInventory, renderAssetCoverageReport } from '../src/catalogue/asset-inventory.js';
import { readJsonc } from '../src/lib/jsonc.js';
import { VEGETATION, BOULDERS } from '../src/plan/vegetation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argument(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const catalogueFile = path.resolve(ROOT, argument('--catalogue', 'library/vanilla-tiles.json'));
const contextFile = path.resolve(ROOT, argument('--context', 'library/vanilla-tile-context.json'));
const prefabIndexFile = path.resolve(ROOT, argument('--prefabs', 'library/extracted/index.json'));
const outputFile = path.resolve(ROOT, argument('--out', 'library/asset-inventory.json'));
const reportFile = path.resolve(ROOT, argument('--report', 'docs/ASSET-COVERAGE.md'));

function collectStrings(value, output) {
  if (typeof value === 'string') {
    if (/^(?:.*_)?[0-9]+$/.test(value)) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectStrings(child, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, output);
  }
}

function prefabAssets(indexFile) {
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const root = path.dirname(indexFile);
  const names = new Set();
  for (const entry of index.buildings ?? []) {
    const prefab = JSON.parse(fs.readFileSync(path.join(root, entry.file), 'utf8'));
    collectStrings(prefab.layers, names);
  }
  return { names, prefabCount: index.buildings?.length ?? 0 };
}

const catalogue = JSON.parse(fs.readFileSync(catalogueFile, 'utf8'));
const contextualUsage = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
const prefabs = prefabAssets(prefabIndexFile);
const semanticRegistry = readJsonc(path.resolve(ROOT, 'config/semantic-mappings.jsonc'));
const semanticAssets = (semanticRegistry.mappings ?? [])
  .flatMap((mapping) => mapping.variants ?? [])
  .map((variant) => typeof variant === 'string' ? variant : variant.tile);
const usedNames = new Set([
  ...prefabs.names,
  ...semanticAssets,
  ...VEGETATION.map(({ tile }) => tile),
  ...BOULDERS,
  'floors_exterior_tilesandstone_01_3',
]);

// These are the only materials SurfaceGrid can currently expose to loadBlendSets.
const usableBlendMaterials = new Set([
  'Grass_Dark', 'Grass_Medium', 'Grass_Light', 'Dirt', 'Sand',
  'Road_04', 'Road_06', 'Water',
]);

const inventory = buildAssetInventory(catalogue, contextualUsage, {
  usedNames,
  usableBlendMaterials,
  source: {
    catalogue: path.relative(ROOT, catalogueFile).replaceAll('\\', '/'),
    contextualUsage: path.relative(ROOT, contextFile).replaceAll('\\', '/'),
    prefabIndex: path.relative(ROOT, prefabIndexFile).replaceAll('\\', '/'),
    retainedPrefabs: prefabs.prefabCount,
    prefabAssetNames: prefabs.names.size,
    directEmitterAssetNames: usedNames.size - prefabs.names.size,
  },
});

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(inventory, null, 2)}\n`);
fs.writeFileSync(reportFile, renderAssetCoverageReport(inventory));

console.log(`wrote ${inventory.summary.assets.toLocaleString()} assets in ${inventory.summary.assetFamilies.toLocaleString()} families`);
console.log(`  ${path.relative(ROOT, outputFile)}`);
console.log(`  ${path.relative(ROOT, reportFile)}`);
console.log(`  ${Object.entries(inventory.summary.supportStatuses).map(([status, count]) => `${status}=${count}`).join(', ')}`);
