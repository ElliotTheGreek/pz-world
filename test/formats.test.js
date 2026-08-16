/**
 * The formats layer is reverse-engineered, so it is only as trustworthy as the
 * evidence behind it. These tests run against the player's own Project Zomboid
 * install: every shipped cell of Muldraugh is parsed, a sample is re-emitted
 * and compared byte for byte, and the cell coordinate convention is re-measured
 * rather than asserted.
 *
 * If Project Zomboid is not installed the suite skips instead of failing —
 * there is nothing to check against.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readLotHeader, writeLotHeader, CHUNKS_PER_CELL } from '../src/formats/lotheader.js';
import { readLotPack, writeLotPack } from '../src/formats/lotpack.js';
import { readCell, listCells, emptyCell, headerPath, packPath } from '../src/formats/cell.js';
import { findInstall } from '../src/lib/pzinstall.js';

let INSTALL = null;
try {
  INSTALL = findInstall();
} catch {
  /* skipped below */
}

const MULDRAUGH = INSTALL ? path.join(INSTALL, 'media/maps/Muldraugh, KY') : null;
const skip = INSTALL && fs.existsSync(MULDRAUGH) ? false : 'Project Zomboid install not found';

/** Deterministic sample so a failure is reproducible. */
function sample(list, n) {
  const step = Math.max(1, Math.floor(list.length / n));
  return list.filter((_, i) => i % step === 0).slice(0, n);
}

test('every shipped lotheader parses to an exact density block', { skip }, () => {
  const cells = listCells(MULDRAUGH);
  assert.ok(cells.length > 4000, `expected the full map, got ${cells.length} cells`);

  let rooms = 0;
  let buildings = 0;
  for (const { cx, cy } of cells) {
    const h = readLotHeader(fs.readFileSync(headerPath(MULDRAUGH, cx, cy)));
    assert.equal(h.version, 1);
    assert.equal(h.chunkW, 8);
    assert.equal(h.chunkH, 8);
    // readLotHeader throws unless the trailing block is exactly this size, so
    // reaching here for all 4,065 cells is the proof that the room graph and
    // building list were consumed correctly.
    assert.equal(h.density.length, CHUNKS_PER_CELL * CHUNKS_PER_CELL);
    rooms += h.rooms.length;
    buildings += h.buildings.length;
  }
  // Measured on Build 42.20.2: 4,065 cells carrying 90,827 rooms across 8,564
  // buildings. Exact figures will move with a game update; an order-of-
  // magnitude drop means the room graph stopped being parsed rather than that
  // the map changed.
  assert.ok(rooms > 80_000, `expected ~90k rooms, got ${rooms}`);
  assert.ok(buildings > 5_000, `expected ~8.5k buildings, got ${buildings}`);
});

test('lotheader re-emits byte for byte', { skip }, () => {
  for (const { cx, cy } of sample(listCells(MULDRAUGH), 60)) {
    const original = fs.readFileSync(headerPath(MULDRAUGH, cx, cy));
    const again = writeLotHeader(readLotHeader(original));
    assert.deepEqual(again, original, `${cx}_${cy}.lotheader differs after round-trip`);
  }
});

test('lotpack re-emits byte for byte', { skip }, () => {
  for (const { cx, cy } of sample(listCells(MULDRAUGH), 40)) {
    const header = readLotHeader(fs.readFileSync(headerPath(MULDRAUGH, cx, cy)));
    const original = fs.readFileSync(packPath(MULDRAUGH, cx, cy));
    const pack = readLotPack(original, {
      levels: header.maxLevel - header.minLevel + 1,
      chunkSize: header.chunkW,
    });
    const again = writeLotPack(pack);
    assert.deepEqual(again, original, `world_${cx}_${cy}.lotpack differs after round-trip`);
  }
});

test('tile indices all resolve through the header table', { skip }, () => {
  for (const { cx, cy } of sample(listCells(MULDRAUGH), 25)) {
    const cell = readCell(MULDRAUGH, cx, cy);
    const n = cell.header.tiles.length;
    for (const chunk of cell.pack.chunks) {
      for (const sq of chunk) {
        if (!sq) continue;
        for (const t of sq.tiles) {
          assert.ok(t >= 0 && t < n, `tile index ${t} out of range 0..${n - 1} in ${cx}_${cy}`);
        }
      }
    }
  }
});

/**
 * The coordinate convention is the one thing here that fails silently — a
 * transposed cell parses cleanly and renders as nonsense. So it is measured,
 * not asserted: room rectangles from the lotheader should land on interior
 * floor tiles, and under any other ordering they land on grass.
 */
test('cell indexing is x-major, measured against room content', { skip }, () => {
  const INTERIOR = /floors_interior|carpet|floors_rug|^floors_/i;
  const cell = readCell(MULDRAUGH, 51, 7);

  let interior = 0;
  let total = 0;
  for (const room of cell.header.rooms) {
    if (room.level !== 0) continue;
    for (const [x, y, w, h] of room.rects) {
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          total++;
          if (cell.tileNames(x + dx, y + dy, 0).some((t) => INTERIOR.test(t))) interior++;
        }
      }
    }
  }

  const pct = (100 * interior) / total;
  // Measured at 91.1%; the next-best ordering scores 64.8% and the two y-major
  // readings score ~40%. Anything under 85% means the convention has moved.
  assert.ok(pct > 85, `only ${pct.toFixed(1)}% of room squares carry an interior floor`);
});

test('an empty cell round-trips', () => {
  const cell = emptyCell();
  const header = writeLotHeader(cell.header);
  const pack = writeLotPack(cell.pack);

  const h2 = readLotHeader(header);
  const p2 = readLotPack(pack, { levels: 1, chunkSize: h2.chunkW });

  assert.equal(h2.rooms.length, 0);
  assert.equal(h2.buildings.length, 0);
  assert.equal(p2.chunks.length, CHUNKS_PER_CELL * CHUNKS_PER_CELL);
  for (const chunk of p2.chunks) {
    assert.equal(chunk.length, 64);
    assert.ok(chunk.every((s) => s === null));
  }
  // A cell with no content is small — this is what makes shipping a large
  // empty world affordable.
  assert.ok(pack.length < 20000, `empty lotpack is ${pack.length} bytes`);
});

test('a malformed record fails loudly rather than exhausting memory', () => {
  const bad = Buffer.alloc(12 + 1024 * 8 + 8);
  bad.write('LOTP', 0, 'ascii');
  bad.writeInt32LE(1, 4);
  bad.writeInt32LE(1024, 8);
  for (let i = 0; i < 1024; i++) bad.writeBigInt64LE(BigInt(12 + 1024 * 8), 12 + i * 8);
  // A square record claiming two billion tiles.
  bad.writeInt32LE(2_000_000_000, 12 + 1024 * 8);

  assert.throws(
    () => readLotPack(bad, { levels: 1, chunkSize: 8 }),
    /bad square record/,
    'an absurd record length must be rejected, not allocated',
  );
});
