/**
 * A whole building, lifted out of a shipped cell with nothing thrown away.
 *
 * This is the counterpart to `harvest.js`, which extracts the same buildings for the
 * worldgen prefab route and is lossy by necessity: `PrefabStructure` declares four tile
 * layers and no level axis, so a prefab is a ground floor with four of its twelve tiles.
 * Authored map cells have neither limit, so nothing here selects, flattens or drops.
 *
 * ## The roofs were never missing, only unread
 *
 * The old extractor reads level 0 (`harvest.js:108`) and takes its level range from
 * `RoomDef.level`. A roof is not a room. Measured on Muldraugh cell 51_7: a building
 * whose room graph says `maxLevel = 0` — a bungalow, single storey by that reckoning —
 * carries 30 squares of tiles at **level 1**, and they are `ceilings_01_0`,
 * `roofs_02_80..83` and `roofs_accents_01_18`. Another such building has 450.
 *
 * So this reads **every level the cell has**, not the levels the rooms mention. That one
 * difference is the roof, the ceiling, and the upper storeys of the 45% of the corpus
 * that has them.
 *
 * ## Nothing large is stored
 *
 * `index()` returns only where each building is — map, cell, bounds, class, room names.
 * The tiles are read from the player's own install at generate time by `read()`. That
 * keeps the library small and keeps the property `docs/PROTOTYPES.md` rests on: the
 * extracted data is derived from The Indie Stone's files on the player's machine and is
 * never redistributed.
 */

import path from 'node:path';

import { buildingBounds } from '../formats/lotheader.js';
import { readCell, listCells } from '../formats/cell.js';
import { listVanillaMaps } from '../lib/pzinstall.js';
import { classifyBuilding } from '../prefab/classify.js';
import { wallFacing, cornerParts } from '../prefab/block.js';

/**
 * A building smaller than this on either edge is a bin store or a map error; larger
 * than this is a mall or a warehouse block that no OSM footprint will ever fit.
 */
const MIN_EDGE = 3;
const MAX_EDGE = 120;

/**
 * Room rectangles cover **interiors**, and Project Zomboid draws a wall on the north or
 * west edge of a square. So a building's south wall lives on the row below its last
 * interior row and its east wall on the column right of its last interior column, both
 * outside the room bounds. Measured on Muldraugh 51_7 building 5: the row at `y+h`
 * carries 11 wall tiles of 11.
 *
 * One square of margin on the east and south is therefore part of the building, not
 * padding — and unlike the prefab route, we keep whatever is there rather than filtering
 * it down to wall-like tiles, because an authored cell can hold the lot.
 */
export const MARGIN = 1;

/**
 * @typedef {{
 *   id: string, map: string, mapDir: string, cx: number, cy: number,
 *   x: number, y: number, w: number, h: number,
 *   cls: string, roomNames: string[], levels: [number, number],
 * }} BuildingRef
 *
 * @typedef {{name: string, level: number, rects: number[][], objects: number[][]}} Room
 *
 * @typedef {{
 *   ref: BuildingRef, w: number, h: number, minLevel: number, maxLevel: number,
 *   squares: (string[]|null)[], rooms: Room[],
 * }} BuildingBlock
 */

/**
 * What survives on a margin square, and why it is not simply "the walls".
 *
 * Treat walls as lattice edges. For an interior of `iw x ih` the lattice has
 * `(iw+1) x (ih+1)` points; a north wall stored at cell `(x,y)` is the horizontal edge
 * from `(x,y)` to `(x+1,y)`, and a west wall is the vertical edge from `(x,y)` to
 * `(x,y+1)`. So:
 *
 *   - a **north** wall is a real edge only for `x <= iw-1` — on the east margin column
 *     it would run off the lattice in x;
 *   - a **west** wall is a real edge only for `y <= ih-1` — on the south margin row it
 *     would run off in y.
 *
 * Which means the south margin row may hold north walls and nothing else, the east
 * margin column may hold west walls and nothing else, and the corner square at
 * `(iw, ih)` may hold **neither** — both of its edges run off the lattice.
 *
 * This is not fussiness. Rotation maps a west wall at `(x,y)` to a north wall at
 * `(ih-y-1, x)`, so a west wall left at `y = ih` lands at `x = -1` and is thrown away by
 * the bounds check — silently, on every quarter-turn. The `(iw, ih)` case is worse
 * because it hides: a north wall there survives the first turn and dies on the second,
 * so it looks fine until a building happens to be placed at 180°. Filtering here instead
 * makes the transform total, and `rotated four times == the original` becomes a fact.
 *
 * Corners are split and only the surviving side is kept.
 *
 * @returns {string[]} the tiles to keep on this margin square
 */
export function filterMargin(tiles, cat, { onSouthEdge, onEastEdge }) {
  const allowNorth = !onEastEdge;
  const allowWest = !onSouthEdge;
  if (!allowNorth && !allowWest) return [];

  const out = [];
  for (const tile of tiles) {
    // Same definition of "edge" the rotator uses — see `wallFacing` in
    // prefab/block.js. When the two disagreed, tiles the reader kept were tiles
    // the rotator had nowhere to put.
    const corner = cornerParts(cat, tile);
    if (corner) {
      if (allowNorth && corner.north) out.push(corner.north);
      if (allowWest && corner.west) out.push(corner.west);
      continue;
    }
    const dir = wallFacing(cat, tile);
    if (dir === 'N' && allowNorth) out.push(tile);
    else if (dir === 'W' && allowWest) out.push(tile);
    else if (!cat && /^walls_|^fencing_|_wall|door|window/i.test(tile)) out.push(tile);
  }
  return out;
}

/** Index into `squares`: level-major, then y, then x. */
export function blockIndex(block, x, y, level) {
  return (level - block.minLevel) * block.w * block.h + y * block.w + x;
}

export function blockTiles(block, x, y, level) {
  if (x < 0 || y < 0 || x >= block.w || y >= block.h) return null;
  if (level < block.minLevel || level > block.maxLevel) return null;
  return block.squares[blockIndex(block, x, y, level)] ?? null;
}

export function setBlockTiles(block, x, y, level, tiles) {
  if (x < 0 || y < 0 || x >= block.w || y >= block.h) return false;
  if (level < block.minLevel || level > block.maxLevel) return false;
  block.squares[blockIndex(block, x, y, level)] = tiles ?? null;
  return true;
}

/** An empty block of the given shape, ready to be filled or rotated into. */
export function emptyBlock(ref, w, h, minLevel, maxLevel, rooms = []) {
  const levels = maxLevel - minLevel + 1;
  return {
    ref,
    w,
    h,
    minLevel,
    maxLevel,
    squares: new Array(w * h * levels).fill(null),
    rooms,
  };
}

/**
 * Every building in one cell, as references.
 *
 * Unlike `harvestCell`, a building straddling the cell edge is **kept**. It was dropped
 * before because a prefab had to come out of one file; `read()` below simply opens the
 * neighbouring cell as well. That is 6.2% of the corpus recovered.
 *
 * @param {import('../formats/lotpack.js').Cell} cell
 * @param {{map: string, mapDir: string, cx: number, cy: number}} where
 * @returns {BuildingRef[]}
 */
export function indexCell(cell, where) {
  const out = [];
  const header = cell.header;

  for (let b = 0; b < header.buildings.length; b++) {
    const bounds = buildingBounds(header, header.buildings[b]);
    if (!bounds) continue;
    if (bounds.w < MIN_EDGE || bounds.h < MIN_EDGE) continue;
    if (bounds.w > MAX_EDGE || bounds.h > MAX_EDGE) continue;
    if (bounds.x < 0 || bounds.y < 0) continue;

    const roomNames = bounds.rooms.map((r) => r.name);
    const { cls } = classifyBuilding(roomNames, bounds.w * bounds.h);

    out.push({
      id: `pzw_${where.map}_${where.cx}_${where.cy}_${b}`,
      map: where.map,
      mapDir: where.mapDir,
      cx: where.cx,
      cy: where.cy,
      x: bounds.x,
      y: bounds.y,
      w: bounds.w + MARGIN,
      h: bounds.h + MARGIN,
      cls,
      roomNames,
      // The room ids this building is made of, straight out of the header's
      // building→room graph. `read` needs these: a building's rooms are the ones
      // the graph names, not every room that happens to overlap its box.
      roomIds: [...header.buildings[b]],
      // What the *rooms* span. Kept for reference only — `read` deliberately
      // ignores it, because the roof sits above it.
      levels: [bounds.minLevel, bounds.maxLevel],
    });
  }
  return out;
}

/**
 * Read a building's tiles, across every level the cell has.
 *
 * @param {BuildingRef} ref
 * @param {{cell(mapDir: string, cx: number, cy: number): import('../formats/lotpack.js').Cell}} source
 * @returns {BuildingBlock}
 */
export function readBuilding(ref, source) {
  const home = source.cell(ref.mapDir, ref.cx, ref.cy);
  const minLevel = home.header.minLevel;
  const maxLevel = home.header.maxLevel;

  const block = emptyBlock(ref, ref.w, ref.h, minLevel, maxLevel);

  // A building can run past the east or south edge of its own cell. Its rooms stay with
  // the cell that declares them — measured: Muldraugh cell 51_7 has room rects reaching
  // x=266 and y=260, and the neighbouring cell has no room touching its west edge — but
  // the *tiles* live in whichever cell the square falls in, so those come from next door.
  const CELL = 256;
  const cellCache = new Map([[`${ref.cx},${ref.cy}`, home]]);
  const cellAt = (cx, cy) => {
    const key = `${cx},${cy}`;
    if (!cellCache.has(key)) {
      let c = null;
      try {
        c = source.cell(ref.mapDir, cx, cy);
      } catch {
        c = null; // off the edge of the map, or a cell that does not exist
      }
      cellCache.set(key, c);
    }
    return cellCache.get(key);
  };

  const iw = ref.w - MARGIN;
  const ih = ref.h - MARGIN;

  for (let level = minLevel; level <= maxLevel; level++) {
    for (let dy = 0; dy < ref.h; dy++) {
      for (let dx = 0; dx < ref.w; dx++) {
        const wx = ref.x + dx;
        const wy = ref.y + dy;
        const cx = ref.cx + Math.floor(wx / CELL);
        const cy = ref.cy + Math.floor(wy / CELL);
        const cell = cx === ref.cx && cy === ref.cy ? home : cellAt(cx, cy);
        if (!cell) continue;

        let tiles = cell.tileNames(wx - (cx - ref.cx) * CELL, wy - (cy - ref.cy) * CELL, level);
        if (!tiles.length) continue;

        // The east and south margin exists to hold the building's own south and
        // east walls. Everything else on those squares is the *neighbour's*
        // ground — the pavement or grass that happened to be beside this house in
        // Muldraugh — and carrying it would paint a strip of somebody else's
        // world beside the building wherever we place it. It is also the one
        // thing rotation cannot move, because the destination grid has no
        // matching margin on its north or west. Filtering it here, once, is what
        // makes rotation lossless.
        if (dx >= iw || dy >= ih) {
          tiles = filterMargin(tiles, source.catalogue, {
            onSouthEdge: dy >= ih,
            onEastEdge: dx >= iw,
          });
          if (!tiles.length) continue;
        }

        setBlockTiles(block, dx, dy, level, tiles);
      }
    }
  }

  // The building's rooms are the ones the header's building→room graph names.
  //
  // This used to take every room in the cell whose rectangle *overlapped* the ref's box,
  // which is a different set and a wrong one. Terraces and civic blocks sit inside one
  // another's bounding boxes, so a house came away carrying its neighbour's rooms: cell
  // 33_35 of one generated city held fifteen copies of `elementaryhall` filed under
  // buildings that were not the school. It also produced room rectangles starting
  // *before* the building — 25 of them with a negative origin, which no shipped cell has
  // in 152,317 rects, because vanilla files a room in the cell holding its top-left
  // corner so a rect only ever runs right and down.
  //
  // Rooms named by the graph are inside `buildingBounds` by construction, so both
  // problems go away at once.
  const roomIds = ref.roomIds ?? [];
  block.rooms = roomIds
    .map((id) => home.header.rooms[id])
    .filter(Boolean)
    .map((r) => ({
      name: r.name,
      level: r.level,
      rects: r.rects.map(([rx, ry, rw, rh]) => [rx - ref.x, ry - ref.y, rw, rh]),
      objects: r.objects.map(([type, ox, oy]) => [type, ox - ref.x, oy - ref.y]),
    }));

  return block;
}

/** How many squares carry anything, and across how many levels. */
export function blockStats(block) {
  let filled = 0;
  let tiles = 0;
  const levels = new Set();
  for (let level = block.minLevel; level <= block.maxLevel; level++) {
    for (let y = 0; y < block.h; y++) {
      for (let x = 0; x < block.w; x++) {
        const t = blockTiles(block, x, y, level);
        if (!t?.length) continue;
        filled++;
        tiles += t.length;
        levels.add(level);
      }
    }
  }
  return { filled, tiles, levels: [...levels].sort((a, b) => a - b) };
}

/**
 * A reader that keeps recently-used cells parsed.
 *
 * A city draws on a couple of thousand distinct buildings spread over a few hundred
 * source cells, and each cell is about a megabyte of binary to parse. Without this the
 * same file is re-read once per building.
 */
export function cellSource(limit = 24, catalogue = null) {
  const cache = new Map();
  return {
    catalogue,
    cell(mapDir, cx, cy) {
      const key = `${mapDir}|${cx}|${cy}`;
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit); // most-recently-used goes to the end
        return hit;
      }
      const cell = readCell(mapDir, cx, cy);
      cache.set(key, cell);
      if (cache.size > limit) cache.delete(cache.keys().next().value);
      return cell;
    },
  };
}

/**
 * Index every building in every shipped map.
 *
 * @param {string} install
 * @param {{onProgress?: (msg: string) => void, maps?: string[]}} [opts]
 * @returns {{buildings: BuildingRef[], stats: object}}
 */
export function indexInstall(install, opts = {}) {
  const buildings = [];
  const stats = { cells: 0, buildings: 0, byClass: new Map() };

  let maps = listVanillaMaps(install);
  if (opts.maps?.length) maps = maps.filter((m) => opts.maps.includes(path.basename(m)));

  for (const mapDir of maps) {
    const map = path.basename(mapDir).replace(/[^A-Za-z0-9]+/g, '');
    let cells;
    try {
      cells = listCells(mapDir);
    } catch {
      continue;
    }

    for (const { cx, cy } of cells) {
      let cell;
      try {
        cell = readCell(mapDir, cx, cy);
      } catch {
        continue;
      }
      stats.cells++;
      for (const ref of indexCell(cell, { map, mapDir, cx, cy })) {
        buildings.push(ref);
        stats.buildings++;
        stats.byClass.set(ref.cls, (stats.byClass.get(ref.cls) ?? 0) + 1);
      }
      if (stats.cells % 250 === 0) {
        opts.onProgress?.(`indexed ${stats.cells} cells, ${stats.buildings} buildings`);
      }
    }
  }

  return { buildings, stats };
}
