/**
 * Lifting buildings out of the player's own Project Zomboid map.
 *
 * This is the answer to "can we collect a bunch of existing house and building
 * prototypes?" — yes, and from the best possible source: the ~9,500 buildings
 * The Indie Stone hand-authored for Knox County, each already carrying named
 * rooms that say what it is.
 *
 * **Nothing harvested here may be redistributed.** It is derived from shipped
 * game data, so extraction runs on the player's own install and writes to
 * `library/extracted/`, which .gitignore excludes. See docs/DECISIONS.md D6.
 *
 * The lossy part is unavoidable and worth being explicit about: a vanilla
 * square holds up to twelve tiles across eight z-levels, and a worldgen prefab
 * holds four tiles on one level. So what comes out is the ground floor, with
 * one tile per layer chosen by the priorities in config/tile-layers.jsonc.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readCell, listCells } from '../formats/cell.js';
import { buildingBounds } from '../formats/lotheader.js';
import { Schematic } from '../prefab/schematic.js';
import { assignSquare, loadLayerRules, LAYERS } from '../prefab/layers.js';
import { classifyBuilding } from '../prefab/classify.js';
import { listVanillaMaps } from '../lib/pzinstall.js';

/**
 * Does this tile draw a wall, a window frame or a door frame?
 *
 * Uses the catalogue's declared facing where available, since that is the
 * game's own answer. The name test is the fallback for callers that have not
 * loaded the catalogue — it agrees with the catalogue on every wall sheet in
 * the vanilla install.
 */
function isWallLike(tile, cat) {
  if (cat) {
    if (cat.splitCorner(tile)) return true;
    const role = cat.role(tile);
    if (role && (role.dir === 'N' || role.dir === 'W')) return true;
    return false;
  }
  return /^walls_|^fixtures_(doors|windows)/.test(tile);
}

/** Buildings outside this range are not useful as prototypes. */
const MIN_EDGE = 3;
const MAX_EDGE = 60;
const MIN_FILL = 0.25;

/**
 * Extract every ground-floor building from one cell.
 *
 * @param {import('../formats/lotpack.js').Cell} cell
 * @param {{mapName: string, cx: number, cy: number}} where
 * @returns {{schematic: Schematic, cls: string, rooms: string[], dropped: number}[]}
 */
export function harvestCell(cell, where, cat = null) {
  const rules = loadLayerRules();
  const out = [];

  for (let b = 0; b < cell.header.buildings.length; b++) {
    const bounds = buildingBounds(cell.header, cell.header.buildings[b]);
    if (!bounds) continue;

    // Ground floor only — a prefab has no level axis.
    if (bounds.minLevel !== 0) continue;
    if (bounds.w < MIN_EDGE || bounds.h < MIN_EDGE) continue;
    if (bounds.w > MAX_EDGE || bounds.h > MAX_EDGE) continue;

    // Room rectangles cover *interiors*, and Project Zomboid stores a wall on
    // the north or west edge of a square — so a building's south wall lives on
    // the row below its last interior row, and its east wall on the column
    // right of its last interior column. Both are outside the room bounds.
    // Measured on Muldraugh 51_7 building 5: the row at y+h carries 11 wall
    // tiles out of 11. Without this margin every extracted building loses two
    // of its four walls.
    const w = bounds.w + 1;
    const h = bounds.h + 1;

    // A building straddling the cell edge is truncated in this file; the rest
    // of it lives in the neighbouring cell and we would emit half a house.
    if (bounds.x < 0 || bounds.y < 0) continue;
    if (bounds.x + w > 256 || bounds.y + h > 256) continue;

    const roomNames = bounds.rooms.map((r) => r.name);
    const area = bounds.w * bounds.h;
    const { cls } = classifyBuilding(roomNames, area);

    const name = `pzw_${where.mapName}_${where.cx}_${where.cy}_${b}`;
    const schematic = new Schematic({
      name,
      cls,
      w,
      h,
      rooms: bounds.rooms
        .filter((r) => r.level === 0)
        .map((r) => ({
          name: r.name,
          rects: r.rects.map(([x, y, w, h]) => [x - bounds.x, y - bounds.y, w, h]),
        })),
    });

    let dropped = 0;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const tiles = cell.tileNames(bounds.x + dx, bounds.y + dy, 0);
        if (!tiles.length) continue;
        const { assigned, dropped: lost } = assignSquare(tiles, rules);
        dropped += lost.length;

        // The margin row and column exist only to hold the south and east
        // walls. Everything else there is ground outside the building, and
        // carrying it would make the prefab paint grass over whatever the
        // planner put beside the house — and it does not survive rotation,
        // because the grid has no matching margin on the north or west.
        const inMargin = dx >= bounds.w || dy >= bounds.h;

        for (const layer of LAYERS) {
          const tile = assigned[layer];
          if (!tile) continue;
          if (inMargin && !isWallLike(tile, cat)) {
            dropped++;
            continue;
          }
          schematic.set(layer, dx, dy, tile);
        }
      }
    }

    // A building that came out mostly empty means the bounding box covered a
    // lot of outdoors — a courtyard, or rooms spread across a block.
    if (schematic.filledSquares / (w * h) < MIN_FILL) continue;

    out.push({ schematic, cls, rooms: roomNames, dropped });
  }

  return out;
}

/**
 * Walk every shipped map and harvest everything.
 *
 * @param {string} install
 * @param {{onProgress?: (msg: string) => void, maps?: string[]}} [opts]
 */
export function harvestInstall(install, opts = {}) {
  const results = [];
  const stats = { cells: 0, buildings: 0, kept: 0, dropped: 0, byClass: new Map() };

  let maps = listVanillaMaps(install);
  if (opts.maps?.length) {
    maps = maps.filter((m) => opts.maps.includes(path.basename(m)));
  }

  for (const dir of maps) {
    const mapName = path.basename(dir).replace(/[^A-Za-z0-9]+/g, '');
    let cells;
    try {
      cells = listCells(dir);
    } catch {
      continue;
    }

    for (const { cx, cy } of cells) {
      stats.cells++;
      let cell;
      try {
        cell = readCell(dir, cx, cy);
      } catch (err) {
        // A cell we cannot parse is worth knowing about but not worth aborting
        // a 4,000-cell sweep over.
        opts.onProgress?.(`skip ${mapName} ${cx}_${cy}: ${err.message}`);
        continue;
      }
      stats.buildings += cell.header.buildings.length;

      for (const got of harvestCell(cell, { mapName, cx, cy })) {
        results.push(got);
        stats.kept++;
        stats.dropped += got.dropped;
        stats.byClass.set(got.cls, (stats.byClass.get(got.cls) ?? 0) + 1);
      }

      if (stats.cells % 250 === 0) {
        opts.onProgress?.(`${stats.cells} cells, ${stats.kept} buildings kept`);
      }
    }
  }

  return { results, stats };
}

/**
 * Write a harvested library to disk as one Lua file per building, bucketed by
 * class. Rotations are *not* written — they are generated at placement time,
 * because four copies of every building would quadruple a library that is
 * already thousands of files.
 */
export function writeLibrary(dir, results, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const index = [];

  for (const { schematic, cls, rooms } of results) {
    const bucket = path.join(dir, cls);
    fs.mkdirSync(bucket, { recursive: true });
    const file = path.join(bucket, `${schematic.name}.json`);
    fs.writeFileSync(file, JSON.stringify(serialise(schematic, rooms), null, 0));
    index.push({
      name: schematic.name,
      cls,
      w: schematic.w,
      h: schematic.h,
      fill: +(schematic.filledSquares / (schematic.w * schematic.h)).toFixed(3),
      file: path.relative(dir, file).replace(/\\/g, '/'),
    });
  }

  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({ generated: opts.stamp ?? null, count: index.length, buildings: index }, null, 2),
  );
  return index;
}

/**
 * The on-disk form is JSON rather than Lua: the library is an intermediate that
 * the generator reads and filters, and only the handful of buildings actually
 * placed in a city are ever emitted as Lua.
 */
export function serialise(schematic, rooms = []) {
  const layers = {};
  for (const layer of LAYERS) {
    const cells = schematic.layers.get(layer);
    if (cells.some(Boolean)) layers[layer] = cells;
  }
  return {
    name: schematic.name,
    cls: schematic.cls,
    w: schematic.w,
    h: schematic.h,
    rooms: schematic.rooms,
    roomNames: rooms,
    layers,
  };
}

/** @returns {Schematic} */
export function deserialise(obj) {
  const s = new Schematic({
    name: obj.name,
    cls: obj.cls,
    w: obj.w,
    h: obj.h,
    rooms: obj.rooms ?? [],
  });
  for (const [layer, cells] of Object.entries(obj.layers ?? {})) {
    s.layers.set(layer, cells);
  }
  return s;
}
