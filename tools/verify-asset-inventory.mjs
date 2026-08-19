#!/usr/bin/env node
/** Validate the generated asset inventory without reading the game install. */

import fs from 'node:fs';
import path from 'node:path';

import { SAFETY_STATUSES, SUPPORT_STATUSES } from '../src/catalogue/asset-inventory.js';

const file = path.resolve(process.argv[2] ?? 'library/asset-inventory.json');
const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(inventory.schemaVersion === 1, `unsupported schema version ${inventory.schemaVersion}`);
assert(Array.isArray(inventory.assets), 'assets must be an array');
assert(Array.isArray(inventory.families), 'families must be an array');
assert(inventory.summary.assets === inventory.assets.length, 'summary asset count mismatch');
assert(inventory.summary.assetFamilies === inventory.families.length, 'summary family count mismatch');

const names = new Set();
const familyCounts = new Map();
const supportCounts = Object.fromEntries(SUPPORT_STATUSES.map((status) => [status, 0]));
const safetyCounts = Object.fromEntries(SAFETY_STATUSES.map((status) => [status, 0]));
for (const asset of inventory.assets) {
  assert(typeof asset.name === 'string' && asset.name.length > 0, 'asset has no name');
  assert(!names.has(asset.name), `duplicate asset ${asset.name}`);
  names.add(asset.name);
  assert(typeof asset.assetFamily === 'string' && asset.assetFamily.length > 0, `${asset.name}: assetFamily missing`);
  assert(typeof asset.role === 'string' && asset.role.length > 0, `${asset.name}: role missing`);
  assert(typeof asset.orientation === 'string' && asset.orientation.length > 0, `${asset.name}: orientation missing`);
  assert(asset.variant && Object.hasOwn(asset.variant, 'index'), `${asset.name}: variant missing`);
  assert(SUPPORT_STATUSES.includes(asset.supportStatus), `${asset.name}: invalid support status ${asset.supportStatus}`);
  assert(SAFETY_STATUSES.includes(asset.safetyStatus), `${asset.name}: invalid safety status ${asset.safetyStatus}`);
  assert(typeof asset.statusReason === 'string' && asset.statusReason.length > 0, `${asset.name}: status reason missing`);
  supportCounts[asset.supportStatus]++;
  safetyCounts[asset.safetyStatus]++;
  familyCounts.set(asset.assetFamily, (familyCounts.get(asset.assetFamily) ?? 0) + 1);
}

for (const status of SUPPORT_STATUSES) {
  assert(supportCounts[status] === (inventory.summary.supportStatuses[status] ?? 0), `${status}: support total mismatch`);
}
for (const status of SAFETY_STATUSES) {
  assert(safetyCounts[status] === (inventory.summary.safetyStatuses[status] ?? 0), `${status}: safety total mismatch`);
}
for (const family of inventory.families) {
  assert(family.assetCount === familyCounts.get(family.name), `${family.name}: family asset count mismatch`);
  assert(Object.values(family.supportStatuses).reduce((sum, count) => sum + count, 0) === family.assetCount, `${family.name}: support distribution mismatch`);
  assert(Object.values(family.safetyStatuses).reduce((sum, count) => sum + count, 0) === family.assetCount, `${family.name}: safety distribution mismatch`);
}
for (const status of SUPPORT_STATUSES) {
  assert(supportCounts[status] > 0, `required support category ${status} is empty`);
}

console.log(`verified ${inventory.assets.length.toLocaleString()} assets in ${inventory.families.length.toLocaleString()} families`);
console.log(`  ${SUPPORT_STATUSES.map((status) => `${status}=${supportCounts[status].toLocaleString()}`).join(', ')}`);
console.log(`  ${SAFETY_STATUSES.map((status) => `${status}=${safetyCounts[status].toLocaleString()}`).join(', ')}`);
