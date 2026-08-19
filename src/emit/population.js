/**
 * The per-chunk zombie intensity field, measured off Muldraugh.
 *
 * `LotHeader.zombieIntensity` is one byte per chunk, 32×32 per cell. Nothing in
 * Java reads it: `ZombiePopulationManager` hands the cell to `PZPopMan64.dll`
 * via `n_loadChunk`, and `MapCollisionData` pulls the byte back out with
 * `LotHeader.getZombieIntensityForChunk` to feed `n_initMetaChunk`. So what the
 * number means numerically cannot be read off the Java side — but what vanilla
 * *writes* can be, and that turns out to say something quite different from what
 * this file used to do.
 *
 * ## What Muldraugh actually contains
 *
 * Across all 4,065 cells with tiles in them, 4,162,560 chunks:
 *
 *     chunks with a room       45,147   mean 1.20
 *     chunks with no room   4,117,413   mean 0.06
 *
 * which reads like "zombies live in buildings" until you count the other way.
 * Of the 148,819 chunks that carry any intensity at all, **only about a fifth
 * contain a room**. The rest are streets, yards, car parks and woodland edge.
 * Intensity is not a building stamp; it is a field that decays outward from
 * built-up land:
 *
 *     chunks with no room, by Chebyshev distance to the nearest roofed chunk
 *       1 chunk away      65,851   47.94% non-zero   mean 0.953
 *       2                 54,988   35.29%            mean 0.704
 *       3-4               96,054   22.15%            mean 0.442
 *       5-8              190,575   11.60%            mean 0.232
 *       9-12             190,161    6.33%            mean 0.124
 *       further        4,389,160    0.38%            mean 0.008
 *
 * and inside built-up land it rises with how much of the chunk is roofed:
 *
 *     roofed   0-25%   16,078   51.7% non-zero   mean 1.01
 *     roofed  25-50%    8,835   53.8%            mean 1.08
 *     roofed  50-75%    5,560   59.1%            mean 1.21
 *     roofed 75-100%   14,674   64.5%            mean 1.47
 *
 * The striking part is the last column of both tables. Divide mean by non-zero
 * rate and every band lands on the same number — **2.0**. Vanilla's field is one
 * probability that decays with distance from buildings, and a value drawn from a
 * single fixed distribution wherever it fires:
 *
 *     1: 31.8%   2: 48.9%   3: 12.1%   4: 5.0%   5-10: 2.2%
 *
 * Nothing in the whole map exceeds 10.
 *
 * ## Why this replaces what was here
 *
 * The previous field stamped `8` on any chunk containing a room and `16` on one
 * more than half covered, and left every other chunk at `0`. Both halves of that
 * were wrong in the same direction:
 *
 *   - 8 and 16 are outside the range vanilla ever writes, so they were being fed
 *     to native code that has never seen them; and
 *   - every street, verge, car park and back yard in the generated city was
 *     exactly zero, when in Muldraugh a chunk one step from a building is
 *     non-zero half the time.
 *
 * A player walking a generated town therefore met zombies only where they
 * happened to cross a building footprint, which is precisely the "there seem to
 * be fewer zombies" report that sent me to measure this. Inflating the indoor
 * number could never fix it, because the streets were not in the field at all.
 *
 * The constants below are the measurement. If a generated city wants to be
 * busier than Knox County, `INTENSITY_SCALE` is the dial, and it scales the
 * probability rather than the value so the numbers handed to the DLL stay inside
 * the range it was built against.
 */

import { hashString } from '../lib/rng.js';

/** Squares in a chunk, one side and total. */
const CHUNK_SIZE = 8;
const CHUNK_SQUARES = CHUNK_SIZE * CHUNK_SIZE;

/** Chunks per cell, one side. */
const CHUNKS_PER_CELL = 32;

/** How far the field is traced outward from built-up land, in chunks. */
const MAX_DISTANCE = 12;

/**
 * Probability that a chunk carries any intensity, by Chebyshev distance in
 * chunks to the nearest roofed chunk. Index 0 is unused — a roofed chunk uses
 * `ROOFED_RATE` instead, since its own coverage predicts it better than its
 * distance to itself does.
 */
const OUTDOOR_RATE = Object.freeze([
  0.5170, // unused; the roofed table covers distance 0
  0.4794, // 1
  0.3529, // 2
  0.2215, 0.2215, // 3-4
  0.1160, 0.1160, 0.1160, 0.1160, // 5-8
  0.0633, 0.0633, 0.0633, 0.0633, // 9-12
]);

/** Beyond `MAX_DISTANCE`: open country, which vanilla still dusts very lightly. */
const REMOTE_RATE = 0.0038;

/** Probability a roofed chunk carries intensity, by quarter of roofed coverage. */
const ROOFED_RATE = Object.freeze([0.517, 0.538, 0.591, 0.645]);

/**
 * The value handed to a chunk that carries any, as a cumulative distribution.
 * Measured over every non-zero chunk in Muldraugh; mean 1.95.
 */
const VALUE_CDF = Object.freeze([
  [1, 0.3177],
  [2, 0.8062],
  [3, 0.9271],
  [4, 0.9772],
  [5, 0.9802],
  [6, 0.9842],
  [7, 0.9948],
  [8, 0.9954],
  [9, 0.9963],
  [10, 1.0000],
]);

/**
 * A global multiplier on the *probability*, not the value.
 *
 * 1 reproduces Knox County. Raising it thins the empty chunks out rather than
 * pushing any single chunk past the 10 vanilla tops out at, which matters
 * because the consumer is native code with no visible bounds check.
 */
export const INTENSITY_SCALE = 1;

/**
 * A uniform 0..1 draw for one chunk.
 *
 * `hashString` is FNV-1a, and on inputs that differ only in their last few
 * characters — which is exactly what `x,y` over a grid produces — its output
 * retains enough structure that the populated share of a ring came out at 30%
 * where the rate said 11.6%. The splitmix32 finaliser costs three operations and
 * removes it; the two are kept separate so nothing else that hashes coordinates
 * has its results moved.
 */
function draw(key) {
  let h = hashString(key);
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return (h >>> 0) / 0x100000000;
}

const bucket = (roll) => {
  for (const [value, cumulative] of VALUE_CDF) if (roll < cumulative) return value;
  return VALUE_CDF[VALUE_CDF.length - 1][0];
};

/**
 * Chebyshev distance, in chunks, from every chunk to the nearest roofed one.
 *
 * A multi-source breadth-first sweep rather than a per-chunk search: the town is
 * hundreds of thousands of chunks and the field has to cross cell boundaries, so
 * this runs once over the whole map instead of once per cell.
 */
function distanceToRoof(roofed, width, height) {
  const distance = new Int16Array(width * height).fill(-1);
  let frontier = [];
  for (let i = 0; i < roofed.length; i++) {
    if (roofed[i]) { distance[i] = 0; frontier.push(i); }
  }
  for (let d = 1; frontier.length && d <= MAX_DISTANCE; d++) {
    const next = [];
    for (const index of frontier) {
      const x = index % width;
      const y = (index / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const at = nx + ny * width;
          if (distance[at] !== -1) continue;
          distance[at] = d;
          next.push(at);
        }
      }
    }
    frontier = next;
  }
  return distance;
}

/**
 * The intensity field for a whole map.
 *
 * `roofed` is one entry per chunk on a `width × height` chunk grid, holding how
 * many of that chunk's 64 squares are inside a room. Returns a byte per chunk on
 * the same grid.
 */
export function populationField(roofed, width, height, seed = '') {
  const distance = distanceToRoof(roofed, width, height);
  const field = new Uint8Array(width * height);
  for (let i = 0; i < field.length; i++) {
    const coverage = roofed[i];
    let rate;
    if (coverage) {
      const quarter = Math.min(3, Math.floor((Math.min(CHUNK_SQUARES, coverage) / CHUNK_SQUARES) * 4 - 1e-9));
      rate = ROOFED_RATE[Math.max(0, quarter)];
    } else {
      const d = distance[i];
      rate = d < 0 ? REMOTE_RATE : OUTDOOR_RATE[Math.min(MAX_DISTANCE, d)];
    }
    rate = Math.min(1, rate * INTENSITY_SCALE);
    // Two independent draws: one decides whether the chunk is populated at all,
    // the other how heavily. Sharing one would correlate "busy" with "occupied"
    // and put every hotspot on the edge of town, which is not what the histogram
    // above says.
    const x = i % width;
    const y = (i / width) | 0;
    if (draw(`zpop:${seed}:${x},${y}`) >= rate) continue;
    field[i] = bucket(draw(`zval:${seed}:${x},${y}`));
  }
  return field;
}

export { CHUNKS_PER_CELL, MAX_DISTANCE };
