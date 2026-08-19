#!/usr/bin/env node
/**
 * What artwork did a build actually put in the world?
 *
 * `verify` says a cell parses and `audit-cells` says it is internally consistent.
 * Neither answers the question this project keeps getting wrong: *which sprites are
 * on the ground*. A build can be flawless and still lay one grass tile over thirty
 * million squares, because the pass that chooses variants collapsed onto one index.
 *
 * So this reads every emitted lotpack and counts placements per asset family and per
 * tile, restricted to the levels a player sees from above. Run it before and after a
 * change and diff the two.
 *
 *   node tools/audit-tile-usage.mjs [mapDir] [--json out.json] [--top 40]
 */

import fs from 'node:fs';
import path from 'node:path';

import { readLotHeader } from '../src/formats/lotheader.js';
import { readLotPack } from '../src/formats/lotpack.js';
import { findUserFolder } from '../src/lib/pzinstall.js';
import { MAP_NAME, MOD_ID } from './make-canvas.js';

/** `foo_bar_01_37` → `foo_bar_01`; a trailing index is the variant, not the family. */
export function assetFamily(name) {
  const match = /^(.*?)_(\d+)$/.exec(name);
  return match ? match[1] : name;
}

export function tileUsage(mapDir, { level = 0 } = {}) {
  const tiles = new Map();
  const families = new Map();
  let squares = 0;
  let placements = 0;
  let cells = 0;

  const headers = fs
    .readdirSync(mapDir)
    .filter((f) => /^\d+_\d+\.lotheader$/.test(f))
    .sort();

  for (const file of headers) {
    const [cx, cy] = file.replace('.lotheader', '').split('_');
    const header = readLotHeader(fs.readFileSync(path.join(mapDir, file)));
    if (!header.tiles.length) continue;
    const packFile = path.join(mapDir, `world_${cx}_${cy}.lotpack`);
    if (!fs.existsSync(packFile)) continue;
    const levels = header.maxLevel - header.minLevel + 1;
    const pack = readLotPack(fs.readFileSync(packFile), { levels });
    cells++;

    const li = level - header.minLevel;
    if (li < 0 || li >= levels) continue;
    const perLevel = 64;

    for (const chunk of pack.chunks) {
      if (!chunk) continue;
      for (let si = 0; si < perLevel; si++) {
        const square = chunk[li * perLevel + si];
        if (!square) continue;
        squares++;
        for (const index of square.tiles) {
          const name = header.tiles[index];
          if (!name) continue;
          placements++;
          tiles.set(name, (tiles.get(name) ?? 0) + 1);
          const family = assetFamily(name);
          families.set(family, (families.get(family) ?? 0) + 1);
        }
      }
    }
  }

  return { cells, squares, placements, tiles, families };
}

function report(usage, top) {
  const lines = [];
  lines.push(
    `${usage.cells} authored cells, ${usage.squares.toLocaleString()} squares at level 0, ` +
      `${usage.placements.toLocaleString()} tile placements`,
  );
  lines.push(`${usage.tiles.size} distinct tiles across ${usage.families.size} asset families`);
  lines.push('');
  lines.push('families:');
  for (const [family, n] of [...usage.families].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    lines.push(`  ${String(n).padStart(12)}  ${family}`);
  }
  lines.push('');
  lines.push('tiles:');
  for (const [tile, n] of [...usage.tiles].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    lines.push(`  ${String(n).padStart(12)}  ${tile}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const args = process.argv.slice(2);
  const jsonAt = args.indexOf('--json');
  const topAt = args.indexOf('--top');
  const top = topAt >= 0 ? Number(args[topAt + 1]) : 40;
  const positional = args.filter((a, i) =>
    !a.startsWith('--') && args[i - 1] !== '--json' && args[i - 1] !== '--top');
  const mapDir =
    positional[0] ?? path.join(findUserFolder(), 'mods', MOD_ID, 'common/media/maps', MAP_NAME);

  const usage = tileUsage(mapDir);
  process.stdout.write(`${report(usage, top)}\n`);
  if (jsonAt >= 0) {
    fs.writeFileSync(
      args[jsonAt + 1],
      JSON.stringify(
        {
          mapDir,
          cells: usage.cells,
          squares: usage.squares,
          placements: usage.placements,
          families: Object.fromEntries([...usage.families].sort((a, b) => b[1] - a[1])),
          tiles: Object.fromEntries([...usage.tiles].sort((a, b) => b[1] - a[1])),
        },
        null,
        1,
      ),
    );
  }
}
