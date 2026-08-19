#!/usr/bin/env node
/** Validate the generated vanilla tile catalogue without reading the game install. */

import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.argv[2] ?? 'library/vanilla-tiles.json');
const catalogue = JSON.parse(fs.readFileSync(file, 'utf8'));
const requiredFamilies = [
  'structural',
  'floor',
  'overlay',
  'vegetation',
  'signage',
  'road',
  'curb',
  'marking',
  'decorative',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(catalogue.schemaVersion === 1, `unsupported schema version ${catalogue.schemaVersion}`);
assert(Array.isArray(catalogue.tiles), 'tiles must be an array');
assert(Array.isArray(catalogue.tilesets), 'tilesets must be an array');
assert(catalogue.summary.tiles === catalogue.tiles.length, 'summary tile count does not match records');
assert(catalogue.summary.tilesets === catalogue.tilesets.length, 'summary tileset count does not match records');
assert(catalogue.source.lotheadersScanned > 0, 'no installed lotheaders were scanned');
for (const family of requiredFamilies) {
  assert(catalogue.summary.families[family] > 0, `required family ${family} is empty`);
}

const names = new Set();
let propertyDefinitions = 0;
let observed = 0;
let observedOnly = 0;
for (const tile of catalogue.tiles) {
  assert(typeof tile.name === 'string' && tile.name.length > 0, 'tile has no name');
  assert(!names.has(tile.name), `duplicate tile ${tile.name}`);
  names.add(tile.name);
  assert(requiredFamilies.includes(tile.family), `${tile.name}: unknown family ${tile.family}`);
  assert(Array.isArray(tile.declaredRoles), `${tile.name}: declaredRoles is missing`);
  assert(Array.isArray(tile.layerSuitability) && tile.layerSuitability.length > 0, `${tile.name}: layer suitability is missing`);
  assert(tile.properties && typeof tile.properties === 'object', `${tile.name}: properties are missing`);
  assert(tile.sources && typeof tile.sources === 'object', `${tile.name}: sources are missing`);
  assert(tile.lotheaderUsage && typeof tile.lotheaderUsage === 'object', `${tile.name}: lotheader usage is missing`);
  assert(tile.lotheaderUsage.cellCount >= tile.lotheaderUsage.mapCount, `${tile.name}: impossible usage counts`);
  if (tile.sources.properties) propertyDefinitions++;
  if (tile.sources.lotheader) observed++;
  if (tile.sources.lotheader && !tile.sources.properties && !tile.sources.declaredSheet) observedOnly++;
}

assert(propertyDefinitions === catalogue.summary.sources.propertyDefinitions, 'property-definition total mismatch');
assert(observed === catalogue.summary.sources.observedLotheaders, 'lotheader-observed total mismatch');
assert(observedOnly === catalogue.summary.sources.observedOnly, 'observed-only total mismatch');

const jumbo = catalogue.tiles.find((tile) => tile.name === 'jumbo_tree_01_0');
assert(jumbo, 'known observed-only tile jumbo_tree_01_0 is absent');
assert(jumbo.sources.lotheader, 'jumbo_tree_01_0 was not observed in lotheaders');
assert(jumbo.sources.absentFromTileDefinitions, 'jumbo_tree_01_0 is not marked absent from definitions');

console.log(`verified ${catalogue.tiles.length.toLocaleString()} tiles in ${catalogue.tilesets.length.toLocaleString()} sheets`);
console.log(`  game ${catalogue.gameVersion}; ${catalogue.source.lotheadersScanned.toLocaleString()} lotheaders scanned`);
console.log(`  ${propertyDefinitions.toLocaleString()} property definitions; ${observed.toLocaleString()} observed names; ${observedOnly.toLocaleString()} observed-only names`);
console.log(`  jumbo_tree_01_0 observed in ${jumbo.lotheaderUsage.cellCount.toLocaleString()} cells`);
console.log(`  families: ${requiredFamilies.map((family) => `${family}=${catalogue.summary.families[family]}`).join(', ')}`);
