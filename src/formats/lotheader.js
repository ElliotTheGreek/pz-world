/**
 * `<cellX>_<cellY>.lotheader` — the tile dictionary and room graph for one cell.
 *
 * Reverse-engineered against Build 42.20.2 and validated by parsing all 4,065
 * cells of `media/maps/Muldraugh, KY` to a byte-exact EOF. See
 * docs/PZ-FORMATS.md for the annotated layout and how it was derived.
 *
 *   "LOTH"                    magic
 *   i32   version             1
 *   i32   tileCount
 *   str[] tileNames           newline-terminated, indexed by the lotpack
 *   i32   chunkW              8   (B41 was 10)
 *   i32   chunkH              8
 *   i32   minLevel            0
 *   i32   maxLevel            highest occupied z-level in this cell
 *   i32   roomCount
 *   room[]:
 *     str   name              "kitchen", "bank", "security" — drives loot
 *     i32   level
 *     i32   rectCount
 *     rect[]: i32 x, y, w, h  cell-local, decomposing an irregular room
 *     i32   objectCount
 *     obj[]:  i32 type, x, y
 *   i32   buildingCount
 *   building[]: i32 roomCount, i32 roomIds[]
 *   u8[chunksPerCell²]        per-chunk zombie density, 32×32 = 1024
 *
 * The room graph is the reason this format matters to us: a `building` is a
 * list of room ids, and each room carries a semantic name. That is what lets
 * the extractor lift a hand-made building out of the vanilla map and know that
 * it is a bank rather than a house.
 */

import { Reader, Writer } from '../lib/binary.js';

export const MAGIC = 'LOTH';
export const VERSION = 1;

/** Squares per cell edge. B42; B41 used 300. */
export const CELL_SIZE = 256;
/** Squares per chunk edge. B42; B41 used 10. */
export const CHUNK_SIZE = 8;
/** Chunks per cell edge — 32. */
export const CHUNKS_PER_CELL = CELL_SIZE / CHUNK_SIZE;

/**
 * @typedef {{name: string, level: number, rects: number[][], objects: number[][]}} RoomDef
 * @typedef {{version: number, tiles: string[], chunkW: number, chunkH: number,
 *            minLevel: number, maxLevel: number, rooms: RoomDef[],
 *            buildings: number[][], density: Buffer}} LotHeader
 */

/**
 * @param {Buffer} buf
 * @returns {LotHeader}
 */
export function readLotHeader(buf) {
  const r = new Reader(buf);

  const magic = r.ascii(4);
  if (magic !== MAGIC) throw new Error(`not a lotheader: magic ${JSON.stringify(magic)}`);

  const version = r.i32();
  const tileCount = r.i32();
  const tiles = new Array(tileCount);
  for (let i = 0; i < tileCount; i++) tiles[i] = r.line();

  const chunkW = r.i32();
  const chunkH = r.i32();
  const minLevel = r.i32();
  const maxLevel = r.i32();

  const roomCount = r.i32();
  const rooms = new Array(roomCount);
  for (let i = 0; i < roomCount; i++) {
    const name = r.line();
    const level = r.i32();
    const rectCount = r.i32();
    const rects = new Array(rectCount);
    for (let j = 0; j < rectCount; j++) rects[j] = [r.i32(), r.i32(), r.i32(), r.i32()];
    const objectCount = r.i32();
    const objects = new Array(objectCount);
    for (let j = 0; j < objectCount; j++) objects[j] = [r.i32(), r.i32(), r.i32()];
    rooms[i] = { name, level, rects, objects };
  }

  const buildingCount = r.i32();
  const buildings = new Array(buildingCount);
  for (let i = 0; i < buildingCount; i++) {
    const n = r.i32();
    const ids = new Array(n);
    for (let j = 0; j < n; j++) ids[j] = r.i32();
    buildings[i] = ids;
  }

  // Whatever is left is the per-chunk density array. Asserting its exact size
  // is what proves the whole preceding parse consumed the right number of
  // bytes — a mis-parsed room would leave this wrong.
  const expected = (CELL_SIZE / chunkW) * (CELL_SIZE / chunkH);
  if (r.remaining !== expected) {
    throw new Error(`density block is ${r.remaining} bytes, expected ${expected}`);
  }
  const density = Buffer.from(r.bytes(expected));

  return { version, tiles, chunkW, chunkH, minLevel, maxLevel, rooms, buildings, density };
}

/**
 * @param {LotHeader} h
 * @returns {Buffer}
 */
export function writeLotHeader(h) {
  const w = new Writer();
  w.ascii(MAGIC);
  w.i32(h.version ?? VERSION);
  w.i32(h.tiles.length);
  for (const t of h.tiles) w.line(t);

  const chunkW = h.chunkW ?? CHUNK_SIZE;
  const chunkH = h.chunkH ?? CHUNK_SIZE;
  w.i32(chunkW);
  w.i32(chunkH);
  w.i32(h.minLevel ?? 0);
  w.i32(h.maxLevel ?? 0);

  w.i32(h.rooms.length);
  for (const room of h.rooms) {
    w.line(room.name);
    w.i32(room.level);
    w.i32(room.rects.length);
    for (const [x, y, rw, rh] of room.rects) w.i32(x).i32(y).i32(rw).i32(rh);
    w.i32(room.objects.length);
    for (const [t, x, y] of room.objects) w.i32(t).i32(x).i32(y);
  }

  w.i32(h.buildings.length);
  for (const ids of h.buildings) {
    w.i32(ids.length);
    for (const id of ids) w.i32(id);
  }

  const expected = (CELL_SIZE / chunkW) * (CELL_SIZE / chunkH);
  const density = h.density ?? Buffer.alloc(expected);
  if (density.length !== expected) {
    throw new Error(`density block is ${density.length} bytes, expected ${expected}`);
  }
  w.bytes(density);

  return w.done();
}

/**
 * An empty cell: no rooms, no buildings, one ground level, and a tile
 * dictionary the caller supplies. This is what the worldgen route needs — the
 * biome map and static modules provide the content, so the cell itself only
 * has to exist and be well-formed.
 *
 * @param {string[]} tiles
 * @returns {LotHeader}
 */
export function emptyLotHeader(tiles = []) {
  return {
    version: VERSION,
    tiles: [...tiles],
    chunkW: CHUNK_SIZE,
    chunkH: CHUNK_SIZE,
    minLevel: 0,
    maxLevel: 0,
    rooms: [],
    buildings: [],
    density: Buffer.alloc(CHUNKS_PER_CELL * CHUNKS_PER_CELL),
  };
}

/**
 * Resolve a building (a list of room ids) into its bounding rectangle and the
 * rooms it contains. Cell-local coordinates.
 *
 * @param {LotHeader} h
 * @param {number[]} roomIds
 */
export function buildingBounds(h, roomIds) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let minLevel = Infinity, maxLevel = -Infinity;
  const rooms = [];
  for (const id of roomIds) {
    const room = h.rooms[id];
    if (!room) continue;
    rooms.push(room);
    if (room.level < minLevel) minLevel = room.level;
    if (room.level > maxLevel) maxLevel = room.level;
    for (const [x, y, w, hh] of room.rects) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + hh > maxY) maxY = y + hh;
    }
  }
  if (!rooms.length) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, minLevel, maxLevel, rooms };
}
