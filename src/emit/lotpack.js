/**
 * Writing real map cells.
 *
 * This is the second of the two emitters `src/plan/index.js` was written for, and the
 * one that makes buildings buildings. The worldgen route (`emit/worldgen.js`) ships
 * instructions and lets the game assemble a world from `PrefabStructure`, which declares
 * four tile layers and no level axis — so everything that comes out of it is a ground
 * floor with four of its twelve tiles and no roof. Authored cells have neither limit.
 *
 * ## What the game requires, and what it silently does instead
 *
 * Three rules govern whether an authored cell is used at all, and each of them fails
 * quietly rather than loudly:
 *
 *   1. **Every chunk must be full at level 0.** `IsoChunk.hasEmptySquaresOnLevelZero()`
 *      returns true if *any* of a chunk's 64 columns is empty, and
 *      `WorldGenChunk.generateChunks` then sends that whole 8x8 chunk down
 *      `genRandomChunk` — the procedural path — instead of `genMapChunk`. One hole in
 *      the floor reverts the chunk. `fillGround` exists for this.
 *
 *   2. **No authored square may carry biome `$random`.** `genMapSquare` *discards and
 *      regenerates* any square whose biome-map entry says `$random`, which is grey 96
 *      — the value the shipped blank canvas uses everywhere. So the biome PNG has to be
 *      rewritten over the authored footprint, exactly as Muldraugh writes TownZone over
 *      town.
 *
 *   3. **Rooms come from the header, not the tiles.** `IsoCell.PlaceLot` sets a square's
 *      room from `metaGrid.getRoomAt(...)`, which is built from the lotheader's RoomDefs.
 *      Every populated square in Muldraugh cell 51_7 — all 112,024 of them — stores
 *      `roomId = -1`. Without RoomDefs a building blocks rain (the roof does that) but
 *      counts as outdoors for temperature, has no `IsoRoom`, no `IsoBuilding`, no alarms,
 *      no room-based loot or zombie population, and no roof cutaway.
 *
 * ## Rooms belong to one cell and may hang off it
 *
 * Room rectangles are cell-local but are *not* clipped to the cell. Muldraugh cell 51_7
 * declares rects reaching x = 266 and y = 260, and its eastern neighbour 52_7 has no room
 * touching its west edge at all. So a building that straddles a boundary keeps its whole
 * room list in one owning cell; only the tile data is split.
 *
 * ## The level range belongs to the cell, not to the generator
 *
 * A cell used to be built with a fixed 0..7. That silently threw away every **basement**:
 * `readBuilding` takes its range from the source cell, 72 of the shipped cells have a
 * negative `minLevel` (down to −17), and a building read out of one of them arrives with
 * tiles below zero. `setSquare` dropped those tiles and `addRoom` kept the RoomDef, so the
 * emitted world carried 1,454 basement rooms with no basement under them.
 *
 * So the range is discovered instead of declared: squares may be placed on any level the
 * game will read (`IsoLot.load` clamps to −32..31), and `finish` trims the cell to the
 * levels that actually carry something — tiles or rooms. That is what the shipped maps
 * look like: 3,068 Muldraugh cells declare `0..0` and 72 declare a negative floor.
 *
 * Levels are stored one sparse plane at a time for the same reason. A dense
 * `levels x 1024 x 64` allocation per cell costs about 2 GB across a city and would grow
 * with every level added; a plane is allocated only when something lands on it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CELL_SIZE, CHUNK_SIZE, CHUNKS_PER_CELL, emptyLotHeader, writeLotHeader } from '../formats/lotheader.js';
import { emptyLotPack, writeLotPack, Cell } from '../formats/lotpack.js';
import { headerPath, packPath, chunkDataPath } from '../formats/cell.js';
import { writeChunkData, encodeChunkData, chunkBits } from './chunkdata.js';

/**
 * The deepest and highest level the game will read.
 *
 * `IsoLot.load` clamps its loop to `max(header.minLevel, -32)` and
 * `min(header.maxLevel, 31)`, so anything outside is written and never read. Muldraugh
 * uses −17..29 of it.
 */
export const LEVEL_FLOOR = -32;
export const LEVEL_CEILING = 31;

/**
 * One cell under construction.
 *
 * Tile names are interned per cell because that is how the format stores them: the
 * lotheader carries a table of names and every square holds indices into it. Nothing in
 * the repo did string-to-index before this — the readers only ever went the other way.
 */
export class CellBuilder {
  constructor(cx, cy, { minLevel = LEVEL_FLOOR, maxLevel = LEVEL_CEILING } = {}) {
    this.cx = cx;
    this.cy = cy;
    // What may be *placed*. What is *declared* comes out of `levelRange()` at finish.
    this.minLevel = Math.max(minLevel, LEVEL_FLOOR);
    this.maxLevel = Math.min(maxLevel, LEVEL_CEILING);

    this.tiles = [];
    this.tileIndex = new Map();
    this.rooms = [];
    this.buildings = [];

    /** level → 1024 chunks, each null or 64 squares. Allocated on first use. */
    this.planes = new Map();

    /**
     * One shared square object per single-tile content, reused across the cell.
     *
     * 93% of a city's squares are plain ground — one interned tile index, `roomId = -1`,
     * and identical to millions of others. Allocating an object and an array for each is
     * what took the build past an 8 GB heap and killed the helper outright; a 2,500 m
     * city is 33 million squares, of which 30.7 million are that.
     *
     * Sharing is safe because a square is never mutated in place: `setSquare` copies the
     * tile list before appending and stores a fresh object, and `finish` only reads.
     */
    this.singles = new Map();
    this.header = emptyLotHeader([]);
    this.pack = null;
    this.cell = null;
    this.squaresWritten = 0;
  }

  /** Chunk index within a plane, and square index within a chunk. Both x-major. */
  static locate(x, y) {
    return {
      ci: ((x / CHUNK_SIZE) | 0) * CHUNKS_PER_CELL + ((y / CHUNK_SIZE) | 0),
      si: (x % CHUNK_SIZE) * CHUNK_SIZE + (y % CHUNK_SIZE),
    };
  }

  /** @returns {{roomId: number, tiles: number[]}|null} */
  squareAt(x, y, level) {
    if (x < 0 || y < 0 || x >= CELL_SIZE || y >= CELL_SIZE) return null;
    const plane = this.planes.get(level);
    if (!plane) return null;
    const { ci, si } = CellBuilder.locate(x, y);
    return plane[ci]?.[si] ?? null;
  }

  placeAt(x, y, level, square) {
    let plane = this.planes.get(level);
    if (!plane) this.planes.set(level, (plane = new Array(CHUNKS_PER_CELL * CHUNKS_PER_CELL).fill(null)));
    const { ci, si } = CellBuilder.locate(x, y);
    let chunk = plane[ci];
    if (!chunk) chunk = plane[ci] = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(null);
    chunk[si] = square;
  }

  intern(name) {
    let i = this.tileIndex.get(name);
    if (i === undefined) {
      i = this.tiles.length;
      this.tiles.push(name);
      this.tileIndex.set(name, i);
    }
    return i;
  }

  /**
   * Put tiles on a square, in cell-local coordinates.
   *
   * `roomId` stays -1, as every shipped cell does; the game binds rooms from the header.
   */
  setSquare(x, y, level, tileNames) {
    if (x < 0 || y < 0 || x >= CELL_SIZE || y >= CELL_SIZE) return false;
    if (level < this.minLevel || level > this.maxLevel) return false;
    if (!tileNames?.length) return false;
    const existing = this.squareAt(x, y, level);
    const tiles = existing ? existing.tiles.slice() : [];
    for (const name of tileNames) tiles.push(this.intern(name));
    this.placeAt(x, y, level, { roomId: -1, tiles });
    if (!existing) this.squaresWritten++;
    return true;
  }

  /** Replace rather than append — used by the ground pass, which owns level 0. */
  putSquare(x, y, level, tileNames) {
    if (x < 0 || y < 0 || x >= CELL_SIZE || y >= CELL_SIZE) return false;
    if (level < this.minLevel || level > this.maxLevel) return false;
    if (!tileNames?.length) return false;
    const existing = this.squareAt(x, y, level);

    let square;
    if (tileNames.length === 1) {
      const idx = this.intern(tileNames[0]);
      square = this.singles.get(idx);
      if (!square) this.singles.set(idx, (square = { roomId: -1, tiles: [idx] }));
    } else {
      square = { roomId: -1, tiles: tileNames.map((n) => this.intern(n)) };
    }

    this.placeAt(x, y, level, square);
    if (!existing) this.squaresWritten++;
    return true;
  }

  hasSquare(x, y, level) {
    return this.squareAt(x, y, level) !== null;
  }

  /** @returns {number} the room's index, for `addBuilding` */
  addRoom(room) {
    this.rooms.push({
      name: room.name,
      level: room.level,
      rects: room.rects.map((r) => [...r]),
      objects: (room.objects ?? []).map((o) => [...o]),
    });
    return this.rooms.length - 1;
  }

  addBuilding(roomIndices) {
    if (!roomIndices.length) return;
    this.buildings.push([...roomIndices]);
  }

  /**
   * Every chunk that has anything in it must be **completely** full at level 0, or the
   * game throws the chunk away and regenerates it. This reports the ones that are not.
   *
   * @returns {{cx: number, cy: number}[]} chunk coordinates with holes
   */
  incompleteChunks() {
    const bad = [];
    for (let ccx = 0; ccx < CHUNKS_PER_CELL; ccx++) {
      for (let ccy = 0; ccy < CHUNKS_PER_CELL; ccy++) {
        let filled = 0;
        for (let sy = 0; sy < CHUNK_SIZE; sy++) {
          for (let sx = 0; sx < CHUNK_SIZE; sx++) {
            if (this.squareAt(ccx * CHUNK_SIZE + sx, ccy * CHUNK_SIZE + sy, 0)) filled++;
          }
        }
        if (filled > 0 && filled < CHUNK_SIZE * CHUNK_SIZE) bad.push({ cx: ccx, cy: ccy, filled });
      }
    }
    return bad;
  }

  /**
   * The levels this cell has to declare.
   *
   * Both tiles and rooms count. A RoomDef on a level the lotpack does not contain is a
   * room with no floor under it — the game builds an `IsoRoom` whose squares do not
   * exist — and that is precisely what a dropped basement produced.
   *
   * Level 0 is always included: an authored cell has ground everywhere by construction
   * (see `incompleteChunks`), so a range that excluded it would be a bug elsewhere.
   */
  levelRange() {
    let lo = 0;
    let hi = 0;
    for (const level of this.planes.keys()) {
      if (level < lo) lo = level;
      if (level > hi) hi = level;
    }
    for (const room of this.rooms) {
      if (room.level < lo) lo = room.level;
      if (room.level > hi) hi = room.level;
    }
    return [Math.max(lo, LEVEL_FLOOR), Math.min(hi, LEVEL_CEILING)];
  }

  /** Flatten the sparse planes into the dense structure the writer wants. */
  finish() {
    const [lo, hi] = this.levelRange();
    const levels = hi - lo + 1;
    const pack = emptyLotPack(levels);
    const perLevel = CHUNK_SIZE * CHUNK_SIZE;

    for (const [level, plane] of this.planes) {
      const li = level - lo;
      if (li < 0 || li >= levels) continue;
      for (let ci = 0; ci < plane.length; ci++) {
        const chunk = plane[ci];
        if (!chunk) continue;
        const dest = pack.chunks[ci];
        for (let si = 0; si < perLevel; si++) {
          if (chunk[si]) dest[li * perLevel + si] = chunk[si];
        }
      }
    }

    this.header.tiles = this.tiles;
    this.header.rooms = this.rooms;
    this.header.buildings = this.buildings;
    this.header.minLevel = lo;
    this.header.maxLevel = hi;
    this.pack = pack;
    this.cell = new Cell(this.header, pack);
    this.levels = levels;
    return this.cell;
  }

  /** Write the three files this cell needs. */
  write(dir) {
    const cell = this.finish();
    fs.mkdirSync(dir, { recursive: true });
    const header = writeLotHeader(cell.header);
    const pack = writeLotPack(cell.pack);
    const chunk = encodeChunkData(chunkBits(cell));
    fs.writeFileSync(headerPath(dir, this.cx, this.cy), header);
    fs.writeFileSync(packPath(dir, this.cx, this.cy), pack);
    writeChunkData(chunkDataPath(dir, this.cx, this.cy), chunk);
    return header.length + pack.length + chunk.length;
  }
}

/**
 * A set of cells addressed by world square, so callers never do cell arithmetic.
 *
 * Everything upstream works in absolute world squares; this is the only place that knows
 * a cell is 256 squares across.
 */
export class CellGrid {
  constructor({ minLevel = LEVEL_FLOOR, maxLevel = LEVEL_CEILING } = {}) {
    this.cells = new Map();
    this.minLevel = minLevel;
    this.maxLevel = maxLevel;
  }

  at(cx, cy) {
    const key = `${cx},${cy}`;
    let b = this.cells.get(key);
    if (!b) {
      b = new CellBuilder(cx, cy, { minLevel: this.minLevel, maxLevel: this.maxLevel });
      this.cells.set(key, b);
    }
    return b;
  }

  /** The builder owning a world square, and that square's cell-local position. */
  locate(x, y) {
    const cx = Math.floor(x / CELL_SIZE);
    const cy = Math.floor(y / CELL_SIZE);
    return { builder: this.at(cx, cy), lx: x - cx * CELL_SIZE, ly: y - cy * CELL_SIZE };
  }

  setSquare(x, y, level, tiles) {
    const { builder, lx, ly } = this.locate(x, y);
    return builder.setSquare(lx, ly, level, tiles);
  }

  putSquare(x, y, level, tiles) {
    const { builder, lx, ly } = this.locate(x, y);
    return builder.putSquare(lx, ly, level, tiles);
  }

  hasSquare(x, y, level) {
    const { builder, lx, ly } = this.locate(x, y);
    return builder.hasSquare(lx, ly, level);
  }

  /**
   * Register a building's rooms in the cell that owns its top-left corner, in that
   * cell's coordinates — overflowing past the edge where the building does, which is
   * what the shipped maps do.
   */
  addBuilding(x, y, rooms) {
    const { builder } = this.locate(x, y);
    const ox = builder.cx * CELL_SIZE;
    const oy = builder.cy * CELL_SIZE;
    const ids = [];
    for (const room of rooms) {
      ids.push(
        builder.addRoom({
          name: room.name,
          level: room.level,
          rects: room.rects.map(([rx, ry, rw, rh]) => [x + rx - ox, y + ry - oy, rw, rh]),
          objects: (room.objects ?? []).map(([type, ox2, oy2]) => [type, x + ox2 - ox, y + oy2 - oy]),
        }),
      );
    }
    builder.addBuilding(ids);
    return ids.length;
  }

  write(dir, { log = () => {} } = {}) {
    let bytes = 0;
    let incomplete = 0;
    for (const builder of this.cells.values()) {
      const holes = builder.incompleteChunks();
      if (holes.length) {
        incomplete += holes.length;
        log(
          `cell ${builder.cx}_${builder.cy}: ${holes.length} chunk(s) are partly filled at level 0 — ` +
            'the game will regenerate those procedurally',
        );
      }
      bytes += builder.write(dir);
    }
    return { cells: this.cells.size, bytes, incompleteChunks: incomplete };
  }
}

export { CELL_SIZE, CHUNK_SIZE };
export const cellPaths = { headerPath, packPath, chunkDataPath, join: path.join };
