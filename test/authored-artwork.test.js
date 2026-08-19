/**
 * The artwork reaches the cells the game loads.
 *
 * Every other road test in this repository passes against `src/plan/roads.js`
 * directly, and for a long time all of them passed while the shipped world had
 * no kerb, no lane line and no junction in it — because `src/emit/generate.js`
 * built its own roads out of one flat band of tarmac and never called any of it.
 * A test that stops at the `TileCanvas` cannot see that.
 *
 * So this one goes the whole way: OSM-shaped features in, `generateWorld` out,
 * then the emitted `.lotpack` files read back off disk with the same readers
 * that read Muldraugh. If a pass stops being wired in, this fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateWorld } from '../src/emit/generate.js';
import { readLotHeader } from '../src/formats/lotheader.js';
import { readLotPack } from '../src/formats/lotpack.js';
import { loadTileCatalogue } from '../src/formats/tiledefs.js';
import { findInstall } from '../src/lib/pzinstall.js';

let install = null;
try {
  install = findInstall();
} catch {
  install = null;
}

// The building index, not the buildings. A town with no houses in it has no
// built-up mask, every street is classified rural, and the urban kerb and
// pavement passes never run — so without this the test would pass by proving
// the wrong thing.
const LIBRARY = new URL('../library/buildings.json', import.meta.url);
let library = null;
if (fs.existsSync(LIBRARY)) {
  const parsed = JSON.parse(fs.readFileSync(LIBRARY, 'utf8'));
  library = parsed.buildings ?? null;
}

const skip = !install
  ? 'no Project Zomboid installation found'
  : (!library?.length ? 'no extracted building index — run npm run extract' : false);

/** A small grid town: two arterials crossing, four residential streets, a highway. */
function town() {
  // Longitude/latitude around a point, converted at roughly one square per metre
  // so the projected geometry lands where the numbers say it does.
  const lat = 44.7;
  const lon = -73.45;
  const m = (dx, dy) => [lon + dx / (111320 * Math.cos((lat * Math.PI) / 180)), lat + dy / 110540];
  const way = (kind, fid, tags, points) => ({ kind, fid, tags, points });

  const roads = [
    way('road', 'ns-arterial', { highway: 'secondary', name: 'Main Street', lanes: '2' },
      [m(0, -900), m(0, 900)]),
    way('road', 'ew-arterial', { highway: 'secondary', name: 'Broad Street', lanes: '2' },
      [m(-900, 0), m(900, 0)]),
    way('road', 'motorway', { highway: 'motorway', lanes: '4', ref: 'I-87' },
      [m(-900, 600), m(900, 600)]),
    way('road', 'diagonal', { highway: 'residential', name: 'Mill Lane' },
      [m(-300, -300), m(300, 300)]),
  ];
  for (let i = 0; i < 4; i++) {
    const offset = -300 + i * 200;
    roads.push(way('road', `res-${i}`, { highway: 'residential', name: `Street ${i}` },
      [m(-400, offset), m(400, offset)]));
  }

  // Enough houses, close enough together, that `builtUpMask` calls this a town —
  // without which no implicit sidewalk is drawn anywhere and the test proves
  // nothing about kerbs.
  const buildings = [];
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const x = -350 + gx * 100;
      const y = -350 + gy * 100;
      buildings.push({
        kind: 'building',
        fid: `house-${gx}-${gy}`,
        tags: { building: 'house' },
        points: [m(x, y), m(x + 14, y), m(x + 14, y + 12), m(x, y + 12), m(x, y)],
      });
    }
  }

  return { buildings, roads, ground: [], objects: [], pois: [] };
}

function emitTown(dir, catalogue) {
  fs.mkdirSync(path.join(dir, 'maps'), { recursive: true });
  return generateWorld(town(), {
    lat: 44.7,
    lon: -73.45,
    radiusM: 900,
    seed: 'authored-artwork',
    library,
    catalogue,
    mapDir: dir,
    canvasSquares: 2048,
  });
}

/** Every tile name at level 0 across every emitted cell, with a count. */
function levelZeroTiles(dir) {
  const counts = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!/^\d+_\d+\.lotheader$/.test(file)) continue;
    const [cx, cy] = file.replace('.lotheader', '').split('_');
    const header = readLotHeader(fs.readFileSync(path.join(dir, file)));
    if (!header.tiles.length) continue;
    const levels = header.maxLevel - header.minLevel + 1;
    const li = 0 - header.minLevel;
    if (li < 0 || li >= levels) continue;
    const pack = readLotPack(fs.readFileSync(path.join(dir, `world_${cx}_${cy}.lotpack`)), { levels });
    for (const chunk of pack.chunks) {
      if (!chunk) continue;
      for (let si = 0; si < 64; si++) {
        const square = chunk[li * 64 + si];
        if (!square) continue;
        for (const index of square.tiles) {
          const name = header.tiles[index];
          if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
    }
  }
  return counts;
}

function familyTotal(counts, prefix) {
  let total = 0;
  for (const [name, n] of counts) if (name.startsWith(prefix)) total += n;
  return total;
}

test('a generated town reaches the cells with kerbs, lane lines and pavements', { skip }, (t) => {
  const catalogue = loadTileCatalogue(install);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pzworld-artwork-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = emitTown(dir, catalogue);
  const counts = levelZeroTiles(dir);

  // The road renderer ran at all.
  assert.ok(result.stats.roads.ways > 0, 'no ways were rendered');
  assert.ok(result.stats.roads.curbs > 0, 'no kerbs were selected');
  assert.ok(result.stats.roads.sidewalks > 0, 'no pavement squares were selected');
  assert.ok(result.stats.roads.intersections > 0, 'no junctions were found');

  // ...and what it selected is on the ground, not only in the plan. These four
  // families were all at or near zero in a shipped build while every unit test
  // in the repository passed.
  assert.ok(familyTotal(counts, 'street_curbs_01') > 200,
    `kerb artwork missing from the cells (${familyTotal(counts, 'street_curbs_01')})`);
  assert.ok(familyTotal(counts, 'street_trafficlines_01') > 20,
    `lane markings missing from the cells (${familyTotal(counts, 'street_trafficlines_01')})`);
  assert.ok(familyTotal(counts, 'floors_exterior_tilesandstone_01') > 500,
    'pavement missing from the cells');
  assert.ok(familyTotal(counts, 'blends_street_01') > 500, 'tarmac missing from the cells');
});

test('a generated town uses every variant of the ground materials it lays', { skip }, (t) => {
  const catalogue = loadTileCatalogue(install);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pzworld-variants-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  emitTown(dir, catalogue);
  const counts = levelZeroTiles(dir);

  // Grass_Dark occupies offsets 0, 5, 6 and 7 of block 1. Vanilla lays all four
  // at 25% each; a build that selected them from a low-frequency field reached
  // only two, which is what made a whole screen one flat texture.
  const grass = [16, 21, 22, 23].map((i) => counts.get(`blends_natural_01_${i}`) ?? 0);
  for (const [i, n] of grass.entries()) {
    assert.ok(n > 0, `grass variant ${[16, 21, 22, 23][i]} was never laid`);
  }
  const total = grass.reduce((a, b) => a + b, 0);
  for (const n of grass) {
    assert.ok(Math.abs(n / total - 0.25) < 0.05,
      `grass variants should be even, got ${grass.map((v) => (v / total).toFixed(3)).join(' ')}`);
  }

  // And more than one asphalt, because a vanilla town road is a patchwork of
  // Road_06, Road_07 and Road_04 rather than one flat material.
  const asphalts = ['blends_street_01_86', 'blends_street_01_102', 'blends_street_01_54']
    .filter((tile) => (counts.get(tile) ?? 0) > 0);
  assert.ok(asphalts.length >= 2,
    `expected the road to be more than one material, saw ${asphalts.join(', ') || 'none'}`);
});
