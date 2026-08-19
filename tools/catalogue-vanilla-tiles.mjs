#!/usr/bin/env node
/**
 * Build the complete vanilla tile inventory from installed Build 42 data.
 *
 * Sources are intentionally combined: `.tiles.txt` supplies sheet dimensions
 * and properties, while every shipped lotheader supplies names that definitions
 * omit. Lotheader usage counts dictionary membership per cell, not placements;
 * contextual placement frequency belongs to the separate cell-usage audit.
 *
 * Run: node tools/catalogue-vanilla-tiles.mjs [--install PATH] [--out PATH]
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildVanillaTileCatalogue } from '../src/catalogue/vanilla-tiles.js';
import { loadTileCatalogue } from '../src/formats/tiledefs.js';
import { findInstall, listVanillaMaps, readVersion } from '../src/lib/pzinstall.js';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readHeaderTileNames(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'LOTH') return [];
  const count = buf.readInt32LE(8);
  const names = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const end = buf.indexOf(0x0a, offset);
    if (end < 0) throw new Error(`truncated tile table at entry ${i} of ${count}`);
    names.push(buf.toString('utf8', offset, end).replace(/\r$/, ''));
    offset = end + 1;
  }
  return names;
}

function scanLotheaders(install) {
  const observations = new Map();
  let cells = 0;
  for (const mapDir of listVanillaMaps(install)) {
    const map = path.basename(mapDir);
    for (const file of fs.readdirSync(mapDir).filter((name) => /^\d+_\d+\.lotheader$/.test(name)).sort()) {
      cells++;
      const cell = `${map}/${file.slice(0, -10)}`;
      for (const name of new Set(readHeaderTileNames(fs.readFileSync(path.join(mapDir, file))))) {
        if (!name) continue;
        let usage = observations.get(name);
        if (!usage) observations.set(name, (usage = { maps: new Set(), cells: new Set() }));
        usage.maps.add(map);
        usage.cells.add(cell);
      }
    }
  }
  return { observations, cells };
}

const install = findInstall(option('--install'));
const output = path.resolve(option('--out', 'library/vanilla-tiles.json'));
const definitions = loadTileCatalogue(install);
const { observations, cells } = scanLotheaders(install);
const catalogue = buildVanillaTileCatalogue(definitions, observations, {
  gameVersion: readVersion(install),
  source: {
    install: path.basename(install),
    tileDefinitionFiles: fs.readdirSync(path.join(install, 'media')).filter((name) => name.endsWith('.tiles.txt')).sort(),
    vanillaMaps: listVanillaMaps(install).map((dir) => path.basename(dir)).sort(),
    lotheadersScanned: cells,
  },
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(catalogue, null, 2)}\n`);
console.log(`wrote ${catalogue.summary.tiles.toLocaleString()} tiles in ${catalogue.summary.tilesets.toLocaleString()} sheets to ${output}`);
console.log(`  ${catalogue.summary.sources.propertyDefinitions.toLocaleString()} carry properties`);
console.log(`  ${catalogue.summary.sources.observedLotheaders.toLocaleString()} occur in lotheaders`);
console.log(`  ${catalogue.summary.sources.observedOnly.toLocaleString()} are observed-only names absent from definitions and declared sheets`);
console.log(`  families: ${Object.entries(catalogue.summary.families).map(([name, count]) => `${name}=${count}`).join(', ')}`);
