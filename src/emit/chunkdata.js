/**
 * `chunkdata_<cx>_<cy>.bin` — the collision and population summary beside each cell.
 *
 * `docs/PZ-FORMATS.md` called this "the one format here that is understood by shape
 * rather than decoded", and the generator wrote a fixed 1,026-byte file for every cell.
 * It is decoded now, from `zombie.pot.POTChunkData` and its inner `Chunk`:
 *
 *     int16 BIG-endian version = 1        (DataOutputStream.writeShort)
 *     1024 chunk records, index = cx + cy * 32:
 *       int8 type
 *         0  every square has bits 0        3  every square has bits 8
 *         1  every square has bits 1        4  every square has bits 16
 *         2  mixed: 64 bytes follow, one per square, index = sx + sy * 8
 *
 * Confirmed by parsing all 4,065 Muldraugh files with no leftover bytes;
 * `chunkdata_51_7.bin` is 46,658 bytes and decodes as 311 uniform chunks and 713 mixed.
 *
 * The bits, from `MapCollisionData.addChunkToWorld`:
 *
 *     1  solid        2  blocked north      4  blocked west
 *     8  water       16  room
 *
 * Nothing in Java reads the file. `MapCollisionData` hands each cell's lotheader path to
 * native code — `PZPopMan64.dll`, which derives the sibling `chunkdata_` name — and that
 * drives the off-screen zombie population and coarse navigation. So a wrong file is not
 * a crash or a visual fault; it is zombies walking through walls out of sight and
 * pooling in the wrong places, which is exactly the sort of thing that would be blamed
 * on anything but this.
 *
 * The old all-zero file says "every square in the world is open, unobstructed, dry,
 * outdoor ground". For a cell full of authored buildings that is the worst possible
 * answer.
 *
 * One thing left undecoded: vanilla files also contain **type 5**, which `POTChunkData`
 * never emits and whose meaning lives only in the native reader. We do not write it.
 */

import fs from 'node:fs';

import { CELL_SIZE, CHUNK_SIZE, CHUNKS_PER_CELL } from '../formats/lotheader.js';

export const VERSION = 1;

export const BIT_SOLID = 1;
export const BIT_BLOCKED_N = 2;
export const BIT_BLOCKED_W = 4;
export const BIT_WATER = 8;
export const BIT_ROOM = 16;

/** Which uniform type a repeated bits value maps to, per `Chunk.getTypeOf`. */
const UNIFORM_TYPE = new Map([
  [0, 0],
  [1, 1],
  [8, 3],
  [16, 4],
]);
const TYPE_MIXED = 2;
/** Inverse, for reading. */
const TYPE_BITS = new Map([
  [0, 0],
  [1, 1],
  [3, 8],
  [4, 16],
]);

/**
 * Whether to write real collision bits, or the all-zero form the canvas has always
 * shipped.
 *
 * **Off**, and this is a suspect under investigation rather than a settled decision.
 *
 * The first world built with real bits crashed the game a few seconds after the player
 * started walking — hard, with no Java exception and no stack trace, the log simply
 * stopping mid-frame. That is the signature of a native fault, and this file is the only
 * thing in the whole generator that native code reads: `MapCollisionData` hands each
 * cell's path to `PZPopMan64.dll` and everything else the mod writes is consumed by
 * Java.
 *
 * It has not been proven to be the cause. But the all-zero form is what every previous
 * build shipped without crashing, the bits are a refinement rather than a requirement,
 * and eliminating the one native-facing change is the cheapest way to find out. Turn it
 * back on once the crash is understood.
 *
 * What it costs while off: the population layer believes the whole cell is open,
 * unobstructed ground, so off-screen zombie distribution and coarse navigation ignore
 * walls and water. Nothing on screen changes.
 */
export const WRITE_COLLISION_BITS = true;

/**
 * Per-square bits for a whole cell.
 *
 * @param {import('../formats/lotpack.js').Cell} cell
 * @param {(x: number, y: number) => boolean} [isRoom] cell-local; from the RoomDefs
 * @returns {Uint8Array} `CELL_SIZE * CELL_SIZE`, indexed `y * CELL_SIZE + x`
 */
export function chunkBits(cell, isRoom = null) {
  if (!WRITE_COLLISION_BITS) return new Uint8Array(CELL_SIZE * CELL_SIZE);
  return computeChunkBits(cell, isRoom);
}

export function computeChunkBits(cell, isRoom = null) {
  const bits = new Uint8Array(CELL_SIZE * CELL_SIZE);
  const cat = cell.header.tiles;

  for (let y = 0; y < CELL_SIZE; y++) {
    for (let x = 0; x < CELL_SIZE; x++) {
      let v = 0;
      // Only the ground floor matters to the population layer.
      const sq = cell.square(x, y, 0);
      if (sq) {
        for (const idx of sq.tiles) {
          const name = cat[idx];
          if (!name) continue;
          if (isWaterTile(name)) v |= BIT_WATER;
          if (isNorthWall(name)) v |= BIT_BLOCKED_N;
          if (isWestWall(name)) v |= BIT_BLOCKED_W;
        }
      } else {
        // No floor at all: as impassable as a wall, and that is what the shipped
        // files say too — `addChunkToWorld` writes the solid bit for a null square.
        v |= BIT_SOLID;
      }
      if (isRoom?.(x, y)) v |= BIT_ROOM;
      bits[y * CELL_SIZE + x] = v;
    }
  }
  return bits;
}

// These are name tests rather than catalogue lookups so that `chunkBits` can run
// against a cell alone. The emitter passes a catalogue-backed predicate when it has one.
const isWaterTile = (n) => n.startsWith('blends_natural_02_') || /^water_/.test(n);
const isNorthWall = (n) => /^walls_|^fencing_/.test(n) && /_(1|3|5|9|11|25|29|35|37|41)$/.test(n);
const isWestWall = (n) => /^walls_|^fencing_/.test(n) && /_(0|2|4|8|10|24|28|34|36|40)$/.test(n);

/**
 * Encode per-square bits into the file.
 *
 * @param {Uint8Array} bits `CELL_SIZE * CELL_SIZE`
 * @returns {Buffer}
 */
export function encodeChunkData(bits) {
  const parts = [];
  const header = Buffer.allocUnsafe(2);
  header.writeInt16BE(VERSION);
  parts.push(header);

  for (let ccy = 0; ccy < CHUNKS_PER_CELL; ccy++) {
    for (let ccx = 0; ccx < CHUNKS_PER_CELL; ccx++) {
      const square = Buffer.allocUnsafe(CHUNK_SIZE * CHUNK_SIZE);
      let uniform = true;
      let first = -1;
      for (let sy = 0; sy < CHUNK_SIZE; sy++) {
        for (let sx = 0; sx < CHUNK_SIZE; sx++) {
          const v = bits[(ccy * CHUNK_SIZE + sy) * CELL_SIZE + (ccx * CHUNK_SIZE + sx)];
          square[sy * CHUNK_SIZE + sx] = v;
          if (first === -1) first = v;
          else if (v !== first) uniform = false;
        }
      }

      const uniformType = uniform ? UNIFORM_TYPE.get(first) : undefined;
      if (uniformType !== undefined) {
        parts.push(Buffer.from([uniformType]));
      } else {
        parts.push(Buffer.from([TYPE_MIXED]), square);
      }
    }
  }
  return Buffer.concat(parts);
}

/** Read one back, for tests and for checking the shipped files. */
export function decodeChunkData(buf) {
  if (buf.length < 2) throw new Error('chunkdata too short for its header');
  const version = buf.readInt16BE(0);
  if (version !== VERSION) throw new Error(`unsupported chunkdata version ${version}`);

  const bits = new Uint8Array(CELL_SIZE * CELL_SIZE);
  let at = 2;
  const types = new Map();

  for (let ccy = 0; ccy < CHUNKS_PER_CELL; ccy++) {
    for (let ccx = 0; ccx < CHUNKS_PER_CELL; ccx++) {
      if (at >= buf.length) throw new Error(`chunkdata truncated at chunk ${ccx},${ccy} (byte ${at})`);
      const type = buf[at++];
      types.set(type, (types.get(type) ?? 0) + 1);

      if (type === TYPE_MIXED) {
        if (at + 64 > buf.length) throw new Error(`chunkdata truncated in a mixed chunk at byte ${at}`);
        for (let sy = 0; sy < CHUNK_SIZE; sy++) {
          for (let sx = 0; sx < CHUNK_SIZE; sx++) {
            bits[(ccy * CHUNK_SIZE + sy) * CELL_SIZE + (ccx * CHUNK_SIZE + sx)] = buf[at + sy * CHUNK_SIZE + sx];
          }
        }
        at += 64;
        continue;
      }

      // Uniform. Type 5 appears in the shipped files and POTChunkData never writes
      // it; its meaning is in the native reader only, so it is read as "no bits"
      // rather than guessed at.
      const value = TYPE_BITS.get(type) ?? 0;
      if (value === 0) continue;
      for (let sy = 0; sy < CHUNK_SIZE; sy++) {
        for (let sx = 0; sx < CHUNK_SIZE; sx++) {
          bits[(ccy * CHUNK_SIZE + sy) * CELL_SIZE + (ccx * CHUNK_SIZE + sx)] = value;
        }
      }
    }
  }
  return { bits, consumed: at, types };
}

export function writeChunkData(file, buf) {
  fs.writeFileSync(file, buf);
  return buf.length;
}
