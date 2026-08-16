/**
 * The `extract` command: harvest a prefab library from the player's own install.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInstall, readVersion, listVanillaMaps } from '../lib/pzinstall.js';
import { loadTileCatalogue } from '../formats/tiledefs.js';
import { readCell, listCells } from '../formats/cell.js';
import { harvestCell, writeLibrary } from './harvest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LIBRARY = path.resolve(HERE, '../../library/extracted');

export async function runExtract(opts = {}) {
  const install = findInstall(opts.install);
  const out = opts.out ?? DEFAULT_LIBRARY;
  const log = opts.log ?? (() => {});

  log(`Project Zomboid ${readVersion(install)} at ${install}`);
  log(`writing to ${out}`);

  const cat = loadTileCatalogue(install);
  log(`tile catalogue: ${cat.size} tiles, ${cat.tilesets.size} sheets, ${cat.corners.size} corners`);

  let maps = listVanillaMaps(install);
  if (opts.maps?.length) {
    const want = new Set(opts.maps.map((m) => m.toLowerCase()));
    maps = maps.filter((m) => want.has(path.basename(m).toLowerCase()));
    if (!maps.length) throw new Error(`no shipped map matched ${opts.maps.join(', ')}`);
  }

  const results = [];
  const byClass = new Map();
  let cells = 0;
  let buildings = 0;
  let skipped = 0;

  for (const dir of maps) {
    const mapName = path.basename(dir).replace(/[^A-Za-z0-9]+/g, '');
    let list;
    try {
      list = listCells(dir);
    } catch {
      continue;
    }
    log(`${path.basename(dir)}: ${list.length} cells`);

    for (const { cx, cy } of list) {
      cells++;
      let cell;
      try {
        cell = readCell(dir, cx, cy);
      } catch (err) {
        skipped++;
        log(`  skip ${cx}_${cy}: ${err.message}`);
        continue;
      }
      buildings += cell.header.buildings.length;

      for (const got of harvestCell(cell, { mapName, cx, cy }, cat)) {
        results.push(got);
        byClass.set(got.cls, (byClass.get(got.cls) ?? 0) + 1);
      }

      if (cells % 500 === 0) log(`  ${cells} cells, ${results.length} buildings harvested`);
    }
  }

  writeLibrary(out, results, { stamp: { install, version: readVersion(install) } });

  const summary = {
    cells,
    buildings,
    harvested: results.length,
    skipped,
    byClass: Object.fromEntries([...byClass].sort((a, b) => b[1] - a[1])),
    out,
  };
  log('');
  log(`harvested ${results.length} buildings from ${buildings} in ${cells} cells`);
  for (const [cls, n] of [...byClass].sort((a, b) => b[1] - a[1])) {
    log(`  ${String(n).padStart(5)}  ${cls}`);
  }
  return summary;
}
