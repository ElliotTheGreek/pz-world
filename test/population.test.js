/**
 * The zombie intensity field reproduces the one Muldraugh ships.
 *
 * This exists because the previous field passed every test in the repository
 * while producing a city whose streets held no zombies at all: it stamped a
 * value on chunks containing a room and left every other chunk at zero, and no
 * test asserted anything about the chunks in between. The numbers below are
 * measured off `media/maps/Muldraugh, KY` — see `src/emit/population.js` for the
 * full tables — so a regression in either direction shows up here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { populationField } from '../src/emit/population.js';
import { readLotHeader } from '../src/formats/lotheader.js';
import { findInstall } from '../src/lib/pzinstall.js';

const CHUNKS = 32;
const CHUNK = 8;
const CELL = 256;

/** A town: a solid block of buildings in the middle of open country. */
function town(width, height, buildings) {
  const roofed = new Uint16Array(width * height);
  for (const [x0, y0, w, h] of buildings) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) roofed[x + y * width] = 64;
    }
  }
  return roofed;
}

test('intensity decays outward from built-up land rather than stopping at the wall', () => {
  // Big enough that each ring holds a few hundred chunks: at the 11.6% rate a
  // hundred-chunk ring has a standard deviation of three points, and the
  // tolerances below would be measuring sampling noise rather than the model.
  const width = 400;
  const height = 400;
  const roofed = town(width, height, [[180, 180, 40, 40]]);
  const field = populationField(roofed, width, height, 'decay');

  // Chebyshev rings around the block, and the share of each that is populated.
  const ring = (d) => {
    let n = 0;
    let populated = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (roofed[x + y * width]) continue;
        const dx = Math.max(180 - x, 0, x - 219);
        const dy = Math.max(180 - y, 0, y - 219);
        if (Math.max(dx, dy) !== d) continue;
        n++;
        if (field[x + y * width]) populated++;
      }
    }
    return populated / n;
  };

  // Measured in Muldraugh: 47.9% at one chunk, 35.3% at two, 22.2% at three or
  // four, 11.6% at five to eight.
  assert.ok(Math.abs(ring(1) - 0.479) < 0.08, `one chunk out: ${ring(1).toFixed(3)}`);
  assert.ok(Math.abs(ring(2) - 0.353) < 0.08, `two chunks out: ${ring(2).toFixed(3)}`);
  assert.ok(Math.abs(ring(4) - 0.222) < 0.07, `four chunks out: ${ring(4).toFixed(3)}`);
  assert.ok(Math.abs(ring(7) - 0.116) < 0.06, `seven chunks out: ${ring(7).toFixed(3)}`);
  assert.ok(ring(1) > ring(4) && ring(4) > ring(11), 'the field does not decay');
});

test('most populated chunks are outdoors, as they are in Muldraugh', () => {
  const width = 200;
  const height = 200;
  // Scattered buildings, roughly a town's worth in a town's worth of country.
  const buildings = [];
  for (let y = 60; y < 140; y += 6) for (let x = 60; x < 140; x += 6) buildings.push([x, y, 2, 2]);
  const roofed = town(width, height, buildings);
  const field = populationField(roofed, width, height, 'outdoors');

  let inside = 0;
  let outside = 0;
  for (let i = 0; i < field.length; i++) {
    if (!field[i]) continue;
    if (roofed[i]) inside++; else outside++;
  }
  // In Muldraugh only about a fifth of non-zero chunks contain a room. The exact
  // ratio depends on how spread out the town is; what must not happen is the old
  // behaviour, where it was all of them.
  assert.ok(outside > inside * 2,
    `population is concentrated indoors: ${inside} roofed vs ${outside} open chunks`);
});

test('no chunk is handed a value outside the range vanilla writes', () => {
  const width = 80;
  const height = 80;
  const roofed = town(width, height, [[30, 30, 20, 20]]);
  const field = populationField(roofed, width, height, 'range');
  let max = 0;
  const seen = new Set();
  for (const v of field) { if (v > max) max = v; seen.add(v); }
  // The byte goes to `n_initMetaChunk` in PZPopMan64.dll and nothing in
  // Muldraugh exceeds 10, so nothing here may either.
  assert.ok(max <= 10, `intensity reached ${max}, above anything vanilla writes`);
  assert.ok(seen.size > 3, 'the field is a step function again rather than a distribution');
});

test('the same seed and the same town give the same field', () => {
  const roofed = town(60, 60, [[20, 20, 10, 10]]);
  const a = populationField(roofed, 60, 60, 'stable');
  const b = populationField(roofed, 60, 60, 'stable');
  assert.deepEqual([...a], [...b]);
  const c = populationField(roofed, 60, 60, 'different');
  assert.notDeepEqual([...a], [...c]);
});

// ---- and the same shape as the real thing ---------------------------------

let install = null;
try { install = findInstall(); } catch { install = null; }

test('the generated field has the same marginals as Muldraugh', { skip: !install && 'no Project Zomboid installation found' }, () => {
  const dir = path.join(install, 'media/maps/Muldraugh, KY');
  let chunks = 0;
  let populated = 0;
  let total = 0;
  let max = 0;
  const values = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!/^\d+_\d+\.lotheader$/.test(f)) continue;
    let header;
    try { header = readLotHeader(fs.readFileSync(path.join(dir, f))); } catch { continue; }
    if (!header.tiles.length) continue;
    for (const v of header.density) {
      chunks++;
      if (!v) continue;
      populated++;
      total += v;
      if (v > max) max = v;
      values.set(v, (values.get(v) ?? 0) + 1);
    }
  }

  assert.ok(chunks > 1e6, 'did not read enough of Muldraugh to say anything');
  assert.equal(max, 10, 'vanilla intensity no longer tops out at 10');
  // Mean where populated is 1.95 across the whole map, and remarkably it is the
  // same in every distance and coverage band — which is why the model is one
  // decaying probability and one fixed value distribution.
  const meanWherePopulated = total / populated;
  assert.ok(Math.abs(meanWherePopulated - 1.95) < 0.1,
    `vanilla mean where populated is ${meanWherePopulated.toFixed(2)}`);

  // The generated value distribution has to match that, wherever it fires.
  const roofed = town(300, 300, [[140, 140, 20, 20]]);
  const field = populationField(roofed, 300, 300, 'marginals');
  let ourTotal = 0;
  let ourPopulated = 0;
  let ourMax = 0;
  for (const v of field) {
    if (!v) continue;
    ourPopulated++;
    ourTotal += v;
    if (v > ourMax) ourMax = v;
  }
  assert.ok(ourMax <= max, `generated intensity reached ${ourMax}, vanilla tops out at ${max}`);
  assert.ok(Math.abs(ourTotal / ourPopulated - meanWherePopulated) < 0.2,
    `generated mean where populated is ${(ourTotal / ourPopulated).toFixed(2)}, `
    + `vanilla ${meanWherePopulated.toFixed(2)}`);
});

test('a cell takes its intensity from the next cell\'s buildings', async () => {
  const { CellGrid } = await import('../src/emit/lotpack.js');
  const grid = new CellGrid();
  // One building in the far corner of cell 1,1 — within twelve chunks of cell
  // 1,0's bottom edge, so that edge must come out populated.
  grid.at(1, 1).addRoom({ name: 'shop', level: 0, rects: [[0, 0, 24, 24]] });
  grid.at(1, 0).setSquare(0, CELL - 1, 0, ['blends_natural_01_16']);
  const summary = grid.applyPopulation('cross-cell');
  assert.ok(summary.populated > 0);

  const above = grid.at(1, 0).density;
  let bottomRow = 0;
  for (let cx = 0; cx < CHUNKS; cx++) if (above[cx + (CHUNKS - 1) * CHUNKS]) bottomRow++;
  assert.ok(bottomRow > 0,
    'the cell above the shop is empty along its shared edge — the field stopped at the cell boundary');
  assert.equal(CHUNK * CHUNKS, CELL);
});
