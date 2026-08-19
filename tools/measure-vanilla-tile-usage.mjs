#!/usr/bin/env node
/**
 * Measure contextual tile placement across decoded vanilla Build 42 cells.
 *
 * Run:
 *   node --max-old-space-size=8192 tools/measure-vanilla-tile-usage.mjs
 *   node tools/measure-vanilla-tile-usage.mjs --install PATH --out PATH
 * Optional sampling/debugging: --map "Muldraugh, KY" --max-cells 10
 */

import fs from 'node:fs';
import path from 'node:path';

import { analyzeCellUsage, serializeContextualUsage } from '../src/catalogue/contextual-usage.js';
import { readCell, listCells } from '../src/formats/cell.js';
import { findInstall, listVanillaMaps, readVersion } from '../src/lib/pzinstall.js';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const install = findInstall(option('--install'));
const output = path.resolve(option('--out', 'library/vanilla-tile-context.json'));
const cataloguePath = path.resolve(option('--catalogue', 'library/vanilla-tiles.json'));
const mapFilter = option('--map', null);
const maxCells = Number(option('--max-cells', '0')) || Infinity;
const relationLimit = Number(option('--relation-limit', '24')) || 24;

if (!fs.existsSync(cataloguePath)) {
  throw new Error(`tile catalogue not found: ${cataloguePath}; run npm run catalogue-tiles first`);
}
const catalogueDocument = JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
const catalogue = new Map(catalogueDocument.tiles.map((tile) => [tile.name, tile]));
const usages = new Map();
const failures = [];
const maps = listVanillaMaps(install)
  .filter((dir) => !mapFilter || path.basename(dir) === mapFilter)
  .sort((a, b) => a.localeCompare(b));
if (!maps.length) throw new Error(`no vanilla maps matched ${JSON.stringify(mapFilter)}`);

let scanned = 0;
let available = 0;
for (const mapDir of maps) {
  const map = path.basename(mapDir);
  const cells = listCells(mapDir);
  available += cells.length;
  for (const { cx, cy } of cells) {
    if (scanned >= maxCells) break;
    const id = `${cx}_${cy}`;
    try {
      const decoded = readCell(mapDir, cx, cy);
      analyzeCellUsage({
        map,
        cell: id,
        width: 256,
        height: 256,
        minLevel: decoded.header.minLevel,
        maxLevel: decoded.header.maxLevel,
        squares: (x, y, z) => decoded.tileNames(x, y, z),
      }, catalogue, usages);
      scanned++;
      if (scanned % 100 === 0) process.stderr.write(`\rscanned ${scanned.toLocaleString()} cells; ${usages.size.toLocaleString()} tiles`);
    } catch (error) {
      failures.push({ map, cell: id, error: error.message });
    }
  }
  if (scanned >= maxCells) break;
}
if (scanned >= 100) process.stderr.write('\n');

const document = serializeContextualUsage(usages, {
  gameVersion: readVersion(install),
  source: {
    install: path.basename(install),
    catalogue: path.relative(process.cwd(), cataloguePath).replaceAll('\\', '/'),
    maps: maps.map((dir) => path.basename(dir)),
    availableCells: available,
    scannedCells: scanned,
    failedCells: failures,
    complete: failures.length === 0 && scanned === available && maxCells === Infinity,
  },
}, relationLimit);

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${document.summary.observedTiles.toLocaleString()} contextual tile records from ${scanned.toLocaleString()} cells to ${output}`);
console.log(`  ${document.summary.placements.toLocaleString()} placements; ${document.summary.highPriorityUndeclaredEvidence.toLocaleString()} high-priority undeclared assets`);
if (failures.length) console.warn(`  warning: ${failures.length} cells failed to decode (recorded in source.failedCells)`);
