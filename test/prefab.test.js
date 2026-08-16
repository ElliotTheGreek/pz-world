/**
 * Rotation is the part of this project most likely to be quietly wrong.
 * A building rotated with a subtle error still renders — it just has a hole in
 * a wall, or a doorway facing a brick face — so these tests check geometry
 * rather than eyeballing output.
 *
 * The synthetic cases pin the maths exactly. The measurements against real
 * vanilla buildings say how well it survives contact with hand-authored data,
 * where a square can carry both a wall and a table and a prefab has only one
 * slot for the pair.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { Schematic, rotate, LAYERS } from '../src/prefab/schematic.js';
import { loadTileCatalogue } from '../src/formats/tiledefs.js';
import { readCell } from '../src/formats/cell.js';
import { harvestCell } from '../src/extract/harvest.js';
import { findInstall } from '../src/lib/pzinstall.js';

let INSTALL = null;
try {
  INSTALL = findInstall();
} catch {
  /* skipped below */
}
const skip = INSTALL ? false : 'Project Zomboid install not found';

let CAT = null;
function catalogue() {
  if (!CAT) CAT = loadTileCatalogue(INSTALL);
  return CAT;
}

const N = 'walls_interior_house_01_1';
const W = 'walls_interior_house_01_0';
const NW = 'walls_interior_house_01_2';

/** A closed rectangular box with an `iw`×`ih` interior. */
function box(iw, ih) {
  const s = new Schematic({ name: 'box', w: iw + 1, h: ih + 1, margin: 1 });
  for (let x = 0; x < iw; x++) {
    s.set('Furniture', x, 0, N); // north
    s.set('Furniture', x, ih, N); // south, on the margin row
  }
  for (let y = 0; y < ih; y++) {
    s.set('Furniture', 0, y, W); // west
    s.set('Furniture', iw, y, W); // east, on the margin column
  }
  s.set('Furniture', 0, 0, NW);
  return s;
}

function render(s) {
  const rows = [];
  for (let y = 0; y < s.h; y++) {
    let row = '';
    for (let x = 0; x < s.w; x++) {
      const v = s.get('Furniture', x, y);
      row += v === NW ? '+' : v === N ? '-' : v === W ? '|' : v ? '?' : '.';
    }
    rows.push(row);
  }
  return rows.join('\n');
}

test('the north/west facing index is a bijection', { skip }, () => {
  const cat = catalogue();
  assert.equal(cat.mirrorNorthWest(N), W);
  assert.equal(cat.mirrorNorthWest(W), N);
  for (const [name] of cat.tiles) {
    assert.equal(
      cat.mirrorNorthWest(cat.mirrorNorthWest(name)),
      name,
      `${name} is not restored by mirroring twice`,
    );
  }
});

test('a corner tile resolves back to the pair it names', { skip }, () => {
  const cat = catalogue();
  assert.deepEqual(cat.splitCorner(NW), { north: N, west: W });
  assert.equal(cat.cornerFor(N, W), NW);
});

test('rotating a closed box four times is the identity', { skip }, () => {
  const cat = catalogue();
  for (const [iw, ih] of [
    [3, 2],
    [1, 1],
    [7, 4],
    [2, 9],
  ]) {
    const src = box(iw, ih);
    let r = src;
    for (let i = 0; i < 4; i++) r = rotate(r, cat, 1);
    assert.equal(r.w, src.w, `${iw}x${ih} width`);
    assert.equal(r.h, src.h, `${iw}x${ih} height`);
    assert.equal(render(r), render(src), `${iw}x${ih} did not survive four turns`);
  }
});

test('a quarter turn transposes the box and keeps it closed', { skip }, () => {
  const cat = catalogue();
  const src = box(3, 2);
  const r = rotate(src, cat, 1);

  assert.equal(r.w, 3);
  assert.equal(r.h, 4);
  // Still a sealed rectangle: north and south runs the full interior width,
  // west and east the full interior height.
  assert.equal(
    render(r),
    ['+-|', '|.|', '|.|', '--.'].join('\n'),
    `unexpected rotation:\n${render(r)}`,
  );
  assert.equal(r.droppedOnRotate, 0);
});

test('rotation of real buildings keeps their walls', { skip }, () => {
  const cat = catalogue();
  const dir = path.join(INSTALL, 'media/maps/Muldraugh, KY');
  // `isWall` rather than a facing test: grime decals carry wall-ish properties
  // but are not walls, and counting them would make this measurement lie.
  const isWall = (t) => !!t && cat.isWall(t);
  const countWalls = (s) => s.layers.get('Furniture').filter(isWall).length;

  const ratios = [];
  let onFloorLayers = 0;
  let count = 0;

  for (const [cx, cy] of [
    [51, 7],
    [49, 6],
    [48, 5],
    [50, 7],
  ]) {
    const cell = readCell(dir, cx, cy);
    for (const { schematic } of harvestCell(cell, { mapName: 'M', cx, cy }, cat)) {
      count++;
      const before = countWalls(schematic);
      const r = rotate(schematic, cat, 1);

      assert.equal(r.w, schematic.h, `${schematic.name} width after turn`);
      assert.equal(r.h, schematic.w, `${schematic.name} height after turn`);

      // A wall drawn on a floor layer lies flat on the ground. It must never
      // happen — the corner fallback exists precisely to avoid it.
      for (const layer of LAYERS) {
        if (layer === 'Furniture') continue;
        onFloorLayers += r.layers.get(layer).filter(isWall).length;
      }
      if (before > 0) ratios.push(countWalls(r) / before);
    }
  }

  assert.ok(count > 50, `expected a decent sample, got ${count}`);
  assert.equal(onFloorLayers, 0, 'walls ended up on a floor layer');

  ratios.sort((a, b) => a - b);
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const median = ratios[ratios.length >> 1];

  // Retention is measured in wall *tiles*, and it does not land exactly on 1.0
  // in either direction. It can exceed 1: a corner tile is one tile carrying
  // two walls, and a quarter turn sends its halves to different squares, so
  // the pair is drawn as two tiles afterwards. It can fall below 1: a prefab
  // square holds one Furniture tile, so where a rotation brings a wall and a
  // table onto the same square, one of them goes.
  //
  // Measured on Build 42.20.2 over 120 buildings:
  //   min 0.667   p10 0.970   median 0.993   p90 1.037   max 1.083   mean 0.994
  //   1 building below 0.9, none below 0.5
  assert.ok(median > 0.97, `median wall retention fell to ${median.toFixed(3)}`);
  assert.ok(mean > 0.97, `mean wall retention fell to ${(100 * mean).toFixed(1)}%`);
  // No building may lose half its walls.
  const badly = ratios.filter((r) => r < 0.5).length;
  assert.equal(badly, 0, `${badly} buildings lost more than half their walls`);
});

test('a schematic emits Lua matching the shape the game loads', () => {
  const s = new Schematic({ name: 'test_prefab', w: 2, h: 2, margin: 0, zombies: 0.01 });
  s.set('Floor', 0, 0, 'blends_street_01_86');
  s.set('Floor', 1, 0, 'blends_street_01_86');
  s.set('Furniture', 0, 1, 'walls_garage_02_20');

  const lua = s.toLua();
  assert.match(lua, /^local test_prefab = \{/m);
  assert.match(lua, /dimensions = \{ 2, 2 \},/);
  assert.match(lua, /zombies = 0\.01,/);
  assert.match(lua, /"blends_street_01_86"/);
  assert.match(lua, /Floor = \{/);
  assert.match(lua, /"1,1"/); // both floor squares use palette entry 1
  assert.match(lua, /"0,0"/); // second floor row is empty
  assert.match(lua, /worldgen\.prefabs\["test_prefab"\] = test_prefab/);
  // Unused layers are omitted rather than emitted as all-zero blocks.
  assert.doesNotMatch(lua, /FloorOverlay/);
});

test('every tile a prefab names exists in the game catalogue', { skip }, () => {
  const cat = catalogue();
  const dir = path.join(INSTALL, 'media/maps/Muldraugh, KY');
  const cell = readCell(dir, 51, 7);
  let checked = 0;
  for (const { schematic } of harvestCell(cell, { mapName: 'M', cx: 51, cy: 7 }, cat)) {
    for (const tile of schematic.palette().tiles) {
      // `tileExists`, not `has`: a .tiles.txt only lists tiles that declare
      // properties, so plain sprites are absent from it but perfectly real.
      assert.ok(cat.tileExists(tile), `${tile} is not a known tile`);
      checked++;
    }
  }
  assert.ok(checked > 100, `expected many tiles, checked ${checked}`);
});
