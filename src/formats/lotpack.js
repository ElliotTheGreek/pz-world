/**
 * `world_<cellX>_<cellY>.lotpack` — the tile data for one cell.
 *
 * Reverse-engineered against Build 42.20.2. See docs/PZ-FORMATS.md.
 *
 *   "LOTP"                 magic
 *   i32   version          1
 *   i32   chunkCount       see below
 *   i64[] chunkOffsets     32×32 = 1024 absolute file offsets
 *   <chunk blobs>
 *
 * The third field is *not* trustworthy as a dimension. Every current map
 * (Muldraugh, Kingsmouth, …) writes 1024 — the chunk count — but the older
 * `challengemaps/Challenge1` files write 8, the chunk edge. In both cases the
 * offset table is 1024 entries beginning at byte 12, so the geometry is taken
 * from the lotheader (which reliably reports chunkW/chunkH = 8) and this field
 * is preserved verbatim only so a re-emitted file is byte-identical.
 *
 * A chunk blob is a flat stream of `levels × chunkSize²` square records, in
 * level-major order. Each record is either
 *
 *   i32 n (>0);  i32 roomId;  i32 tileIndex[n-1]      an occupied square
 *   i32 -1;      i32 skipCount                        skip that many squares
 *
 * so `n` counts the ints that follow, of which the first is the room id and
 * the rest are indices into the lotheader's tile table. `roomId` is -1 for a
 * square that belongs to no room. The skip run is what keeps a wilderness cell
 * small: an empty chunk is eight bytes.
 *
 * The number of levels comes from the lotheader (`maxLevel - minLevel + 1`),
 * so a lotpack cannot be parsed without its header.
 */

import { Reader, Writer } from '../lib/binary.js';
import { CELL_SIZE, CHUNK_SIZE, CHUNKS_PER_CELL } from './lotheader.js';

export const MAGIC = 'LOTP';
export const VERSION = 1;

/**
 * Upper bound on the ints in one square record. The densest square in
 * Muldraugh carries 3 tiles; this is a loose guard, not a format constraint.
 */
const MAX_TILES_PER_SQUARE = 256;

/**
 * @typedef {{roomId: number, tiles: number[]}} Square
 * @typedef {{version: number, headerField: number, chunkSize: number,
 *            levels: number, chunks: (Square|null)[][]}} LotPack
 */

/**
 * @param {Buffer} buf
 * @param {{levels: number, chunkSize?: number}} geom  from the lotheader
 * @returns {LotPack}
 */
export function readLotPack(buf, geom) {
  const { levels, chunkSize = CHUNK_SIZE } = geom;
  if (!Number.isInteger(levels) || levels < 1) {
    throw new Error(`levels must come from the lotheader, got ${levels}`);
  }

  const r = new Reader(buf);
  const magic = r.ascii(4);
  if (magic !== MAGIC) throw new Error(`not a lotpack: magic ${JSON.stringify(magic)}`);
  const version = r.i32();
  const headerField = r.i32();

  const chunkCount = CHUNKS_PER_CELL * CHUNKS_PER_CELL;
  const offsets = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) offsets[i] = r.i64();

  const perChunk = levels * chunkSize * chunkSize;
  const chunks = new Array(chunkCount);

  for (let i = 0; i < chunkCount; i++) {
    const start = offsets[i];
    const end = i + 1 < chunkCount ? offsets[i + 1] : buf.length;
    chunks[i] = readChunk(buf, start, end, perChunk);
  }

  return { version, headerField, chunkSize, levels, chunks };
}

/**
 * @returns {(Square|null)[]} length `perChunk`, null for an empty square
 */
function readChunk(buf, start, end, perChunk) {
  const squares = new Array(perChunk).fill(null);
  const r = new Reader(buf, start);
  let i = 0;

  while (i < perChunk && r.off < end) {
    const n = r.i32();
    if (n === -1) {
      i += r.i32();
      continue;
    }
    // A square cannot plausibly carry more than a few dozen tiles. Bounding
    // this turns a misparse into an error at the offending offset instead of a
    // multi-gigabyte allocation that reports nothing useful.
    if (n < 1 || n > MAX_TILES_PER_SQUARE) {
      throw new Error(`bad square record n=${n} at offset ${r.off - 4}`);
    }
    const roomId = r.i32();
    const tiles = new Array(n - 1);
    for (let k = 0; k < n - 1; k++) tiles[k] = r.i32();
    squares[i++] = { roomId, tiles };
  }

  if (r.off !== end) {
    throw new Error(`chunk consumed ${r.off - start} bytes of ${end - start}`);
  }
  return squares;
}

/**
 * @param {LotPack} pack
 * @returns {Buffer}
 */
export function writeLotPack(pack) {
  const chunkSize = pack.chunkSize ?? CHUNK_SIZE;
  const chunkCount = CHUNKS_PER_CELL * CHUNKS_PER_CELL;
  const perChunk = pack.levels * chunkSize * chunkSize;

  const w = new Writer();
  w.ascii(MAGIC);
  w.i32(pack.version ?? VERSION);
  // Preserved verbatim on a round-trip; new cells write the chunk count, which
  // is what every current shipped map does.
  w.i32(pack.headerField ?? chunkCount);
  const tableAt = w.reserve(chunkCount * 8);

  for (let i = 0; i < chunkCount; i++) {
    w.patchI64(tableAt + i * 8, w.off);
    writeChunk(w, pack.chunks[i] ?? new Array(perChunk).fill(null), perChunk);
  }

  return w.done();
}

/**
 * Empty squares are coalesced into the longest possible skip run, which is
 * what the shipped files do — the round-trip test in test/formats.test.js is
 * what holds this honest.
 */
function writeChunk(w, squares, perChunk) {
  let i = 0;
  while (i < perChunk) {
    if (squares[i] == null) {
      let run = 0;
      while (i + run < perChunk && squares[i + run] == null) run++;
      w.i32(-1).i32(run);
      i += run;
      continue;
    }
    const sq = squares[i];
    w.i32(sq.tiles.length + 1);
    w.i32(sq.roomId);
    for (const t of sq.tiles) w.i32(t);
    i++;
  }
}

/**
 * A cell with no tiles at all: every chunk is a single skip run.
 * @param {number} levels
 */
export function emptyLotPack(levels = 1) {
  const perChunk = levels * CHUNK_SIZE * CHUNK_SIZE;
  const chunkCount = CHUNKS_PER_CELL * CHUNKS_PER_CELL;
  const chunks = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) chunks[i] = new Array(perChunk).fill(null);
  return { version: VERSION, headerField: chunkCount, chunkSize: CHUNK_SIZE, levels, chunks };
}

/**
 * Random access into a parsed cell by cell-local square coordinates.
 *
 * Both indices are **x-major**: the chunk index is `cx * 32 + cy` and the
 * square index within a chunk is `sx * 8 + sy`. This is the opposite of the
 * row-major convention most raster code assumes, and getting it wrong
 * transposes the whole cell without ever erroring.
 *
 * It was determined by content, not by guessing. `roomId` is -1 on every
 * square in the shipped files (the game binds rooms at runtime from the
 * lotheader RoomDefs, which is what `WorldGenChunk.setRoomID` is for), so the
 * discriminator is what the tiles *are*: sample the squares covered by every
 * ground-floor room rectangle in cell 51_7 and ask how many carry an interior
 * floor tile.
 *
 *   chunk x-major, square x-major   91.1% interior floor,  0.5% outdoor ground
 *   chunk x-major, square y-major   64.8%                 22.2%
 *   chunk y-major, square x-major   40.6%                 27.2%
 *   chunk y-major, square y-major   39.5%                 30.8%
 *
 * `test/formats.test.js` re-runs that measurement so a regression shows up as
 * a number, not a crash.
 */
export class Cell {
  /**
   * @param {import('./lotheader.js').LotHeader} header
   * @param {LotPack} pack
   */
  constructor(header, pack) {
    this.header = header;
    this.pack = pack;
    this.levels = pack.levels;
    this.chunkSize = pack.chunkSize;
  }

  /**
   * @param {number} x cell-local 0..255
   * @param {number} y cell-local 0..255
   * @param {number} level absolute z, offset by header.minLevel internally
   * @returns {Square|null}
   */
  square(x, y, level = 0) {
    if (x < 0 || y < 0 || x >= CELL_SIZE || y >= CELL_SIZE) return null;
    const li = level - this.header.minLevel;
    if (li < 0 || li >= this.levels) return null;

    const cs = this.chunkSize;
    const cx = (x / cs) | 0;
    const cy = (y / cs) | 0;
    const chunk = this.pack.chunks[cx * CHUNKS_PER_CELL + cy];
    if (!chunk) return null;

    const sx = x % cs;
    const sy = y % cs;
    return chunk[li * cs * cs + sx * cs + sy] ?? null;
  }

  /** Mutating counterpart of {@link square}, used by the lotpack emitter. */
  setSquare(x, y, level, sq) {
    const li = level - this.header.minLevel;
    if (x < 0 || y < 0 || x >= CELL_SIZE || y >= CELL_SIZE) return false;
    if (li < 0 || li >= this.levels) return false;
    const cs = this.chunkSize;
    const chunk = this.pack.chunks[((x / cs) | 0) * CHUNKS_PER_CELL + ((y / cs) | 0)];
    if (!chunk) return false;
    chunk[li * cs * cs + (x % cs) * cs + (y % cs)] = sq;
    return true;
  }

  /** Tile names on a square, resolved through the header's tile table. */
  tileNames(x, y, level = 0) {
    const sq = this.square(x, y, level);
    if (!sq) return [];
    return sq.tiles.map((i) => this.header.tiles[i]).filter(Boolean);
  }
}
