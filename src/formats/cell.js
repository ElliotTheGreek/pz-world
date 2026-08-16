/**
 * Reading and writing a whole cell — the `.lotheader` and its `world_*.lotpack`
 * are useless apart, since the pack's level count and chunk size come from the
 * header and its tile indices resolve through the header's table.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readLotHeader, writeLotHeader, emptyLotHeader, CELL_SIZE } from './lotheader.js';
import { readLotPack, writeLotPack, emptyLotPack, Cell } from './lotpack.js';

export { CELL_SIZE };

export function headerPath(dir, cx, cy) {
  return path.join(dir, `${cx}_${cy}.lotheader`);
}

export function packPath(dir, cx, cy) {
  return path.join(dir, `world_${cx}_${cy}.lotpack`);
}

export function chunkDataPath(dir, cx, cy) {
  return path.join(dir, `chunkdata_${cx}_${cy}.bin`);
}

/**
 * @param {string} dir  a map directory, e.g. `media/maps/Muldraugh, KY`
 * @returns {Cell}
 */
export function readCell(dir, cx, cy) {
  const header = readLotHeader(fs.readFileSync(headerPath(dir, cx, cy)));
  const pack = readLotPack(fs.readFileSync(packPath(dir, cx, cy)), {
    levels: header.maxLevel - header.minLevel + 1,
    chunkSize: header.chunkW,
  });
  return new Cell(header, pack);
}

/** @param {Cell} cell */
export function writeCell(dir, cx, cy, cell) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(headerPath(dir, cx, cy), writeLotHeader(cell.header));
  fs.writeFileSync(packPath(dir, cx, cy), writeLotPack(cell.pack));
}

/**
 * A cell containing nothing. The worldgen route ships these so that the cell
 * exists and is well-formed; the biome map and static modules supply all of
 * its content at load time.
 */
export function emptyCell() {
  return new Cell(emptyLotHeader([]), emptyLotPack(1));
}

/** Every `<cx>_<cy>` present in a map directory. */
export function listCells(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d+)_(\d+)\.lotheader$/.exec(f);
    if (m) out.push({ cx: +m[1], cy: +m[2] });
  }
  return out.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
}

/**
 * `chunkdata_<cx>_<cy>.bin` accompanies every shipped cell. Its contents are
 * not needed to render a map — the shipped wilderness files are 1026 bytes of
 * near-zero — but the game expects the file to be present, so new cells copy
 * the shape rather than inventing one.
 */
export function writeChunkData(dir, cx, cy, bytes) {
  fs.writeFileSync(chunkDataPath(dir, cx, cy), bytes);
}
