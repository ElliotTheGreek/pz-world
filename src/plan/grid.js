/**
 * A sparse raster over the world, addressed in world squares.
 *
 * A generated city is far too big to hold densely: at one square per metre a
 * 12 km radius is 576 million squares. But a city is also mostly nothing, and
 * Project Zomboid already divides the world into 256×256 cells — the same unit
 * the biome map is written in. So the raster is a map of cell → byte array,
 * allocated on first touch.
 *
 * That makes the memory cost proportional to the area actually built on, and it
 * means the emitter can walk `cells()` and write exactly the files it needs
 * rather than working out which ones would have been empty.
 */

import { CELL_SIZE } from '../formats/lotheader.js';

export class SparseGrid {
  /** @param {number} fill  the value an untouched square reads as */
  constructor(fill = 0) {
    this.fill = fill;
    /** @type {Map<string, Uint8Array>} */
    this.cells = new Map();
  }

  static key(cx, cy) {
    return `${cx},${cy}`;
  }

  static parseKey(key) {
    const [cx, cy] = key.split(',');
    return { cx: +cx, cy: +cy };
  }

  /** Cell containing a world square, and the offset within it. */
  static locate(x, y) {
    const cx = Math.floor(x / CELL_SIZE);
    const cy = Math.floor(y / CELL_SIZE);
    return { cx, cy, ox: x - cx * CELL_SIZE, oy: y - cy * CELL_SIZE };
  }

  #cell(cx, cy, create) {
    const key = SparseGrid.key(cx, cy);
    let buf = this.cells.get(key);
    if (!buf && create) {
      buf = new Uint8Array(CELL_SIZE * CELL_SIZE).fill(this.fill);
      this.cells.set(key, buf);
    }
    return buf;
  }

  get(x, y) {
    const { cx, cy, ox, oy } = SparseGrid.locate(x, y);
    const buf = this.#cell(cx, cy, false);
    return buf ? buf[oy * CELL_SIZE + ox] : this.fill;
  }

  set(x, y, value) {
    const { cx, cy, ox, oy } = SparseGrid.locate(x, y);
    this.#cell(cx, cy, true)[oy * CELL_SIZE + ox] = value;
  }

  /** Ensure a cell exists even if nothing is drawn in it. */
  touch(cx, cy) {
    this.#cell(cx, cy, true);
  }

  /** @returns {{cx: number, cy: number, data: Uint8Array}[]} */
  list() {
    const out = [];
    for (const [key, data] of this.cells) {
      const { cx, cy } = SparseGrid.parseKey(key);
      out.push({ cx, cy, data });
    }
    return out.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  }

  get cellCount() {
    return this.cells.size;
  }
}

/**
 * The same idea for tile names rather than bytes — used while painting roads,
 * where each square carries up to four layers.
 *
 * Kept separate from SparseGrid because the storage is completely different:
 * strings in a Map keyed by square, not a byte per square. Roads cover a small
 * fraction of a city, so a hash map is the right shape and a dense array would
 * be mostly empty.
 */
export class TileCanvas {
  constructor() {
    /** @type {Map<number, Record<string,string>>} */
    this.squares = new Map();
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
  }

  /**
   * Pack a signed square coordinate pair into one number.
   *
   * The key must stay an exact integer, so the product has to fit in a double's
   * 53-bit mantissa: with a 2^22 span per axis the largest key is 2^44, which
   * is exact, and the addressable range is ±2,097,152 squares — about two
   * thousand kilometres, against a Project Zomboid world of tens.
   */
  static SPAN = 1 << 22;
  static BIAS = 1 << 21;

  static key(x, y) {
    if (
      x < -TileCanvas.BIAS || x >= TileCanvas.BIAS ||
      y < -TileCanvas.BIAS || y >= TileCanvas.BIAS
    ) {
      throw new RangeError(`square ${x},${y} is outside the addressable world`);
    }
    return (x + TileCanvas.BIAS) * TileCanvas.SPAN + (y + TileCanvas.BIAS);
  }

  static unkey(k) {
    const y = (k % TileCanvas.SPAN) - TileCanvas.BIAS;
    const x = (k - (y + TileCanvas.BIAS)) / TileCanvas.SPAN - TileCanvas.BIAS;
    return [x, y];
  }

  set(x, y, layer, tile) {
    if (!tile) return;
    const k = TileCanvas.key(x, y);
    let sq = this.squares.get(k);
    if (!sq) this.squares.set(k, (sq = {}));
    sq[layer] = tile;
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }

  get(x, y) {
    return this.squares.get(TileCanvas.key(x, y)) ?? null;
  }

  /** Remove one authored layer without disturbing other content on the square. */
  delete(x, y, layer) {
    const key = TileCanvas.key(x, y);
    const square = this.squares.get(key);
    if (!square || !(layer in square)) return false;
    delete square[layer];
    if (!Object.keys(square).length) this.squares.delete(key);
    return true;
  }

  has(x, y) {
    return this.squares.has(TileCanvas.key(x, y));
  }

  get size() {
    return this.squares.size;
  }

  *entries() {
    for (const [k, layers] of this.squares) {
      const [x, y] = TileCanvas.unkey(k);
      yield { x, y, layers };
    }
  }
}
