/**
 * The world recipe, and the determinism it rests on.
 *
 * Multiplayer works one way here: everyone builds the same town from the same
 * recipe on their own machine, because Project Zomboid does not stream map cells
 * and every client loads them off its own disk. That only holds if the build is
 * reproducible, so the last test in this file is the one that matters — it
 * builds the same small world twice and compares every byte.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  RECIPE_FORMAT,
  buildRecipe,
  compareRecipes,
  manifestOf,
  readRecipe,
  writeRecipe,
} from '../src/emit/recipe.js';

const OSM = JSON.stringify({
  elements: [
    { type: 'way', id: 1, tags: { highway: 'residential', name: 'Cornelia Street' } },
    { type: 'way', id: 2, tags: { building: 'house' } },
  ],
});

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pzworld-recipe-'));
}

test('a recipe carries everything that decides a world, and nothing of the game', () => {
  const recipe = buildRecipe({
    lat: 44.6995, lon: -73.4529, radius: 2500, seed: 0,
    name: 'Plattsburgh, NY', gameVersion: '42.20.3', generator: '0.1.0', osm: OSM,
  });

  assert.equal(recipe.format, RECIPE_FORMAT);
  assert.equal(recipe.lat, 44.6995);
  // The seed is a string: it reaches the hash as text, and 0 and "0" must not
  // become different worlds through a JSON round trip.
  assert.equal(recipe.seed, '0');
  assert.equal(typeof recipe.seed, 'string');
  assert.match(recipe.attribution, /OpenStreetMap/);
  assert.match(recipe.attribution, /ODbL/);

  // Nothing derived from the installed game may travel in here — only the
  // version string that says which one to expect.
  const text = JSON.stringify({ ...recipe, osm: null });
  assert.ok(!/blends_|floors_|walls_|street_curbs/.test(text),
    'a recipe must not carry tile names from the game');
});

test('the map data survives the round trip and is much smaller for it', () => {
  const recipe = buildRecipe({ lat: 1, lon: 2, radius: 300, seed: 'x', osm: OSM });
  assert.equal(recipe.osm.encoding, 'gzip+base64');
  assert.equal(recipe.osm.bytes, Buffer.byteLength(OSM, 'utf8'));

  const dir = tmp();
  try {
    const file = path.join(dir, 'town.json');
    writeRecipe(file, recipe);
    const { recipe: back, osm } = readRecipe(file);
    assert.equal(osm, OSM, 'the OpenStreetMap payload changed in transit');
    assert.equal(back.lat, 1);
    assert.equal(back.seed, 'x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a recipe from a future format is refused rather than half-read', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'future.json');
    fs.writeFileSync(file, JSON.stringify({ format: 'pz-world-recipe-99', lat: 1, lon: 2, radius: 3 }));
    // Half-loading would produce a world that is subtly not the one it names,
    // which is the worst possible failure for a file whose whole job is being
    // reproducible.
    assert.throws(() => readRecipe(file), /pz-world-recipe-1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupted map data is caught instead of building a different town', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'torn.json');
    const recipe = buildRecipe({ lat: 1, lon: 2, radius: 300, seed: '1', osm: OSM });
    recipe.osm.bytes = recipe.osm.bytes + 100; // as a truncated download would look
    writeRecipe(file, recipe);
    assert.throws(() => readRecipe(file), /truncated or corrupt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a mismatch between two players is reported in terms they can act on', () => {
  const mine = manifestOf(buildRecipe({
    lat: 44.6995, lon: -73.4529, radius: 2500, seed: '0', gameVersion: '42.20.3', osm: OSM,
  }));
  const theirs = manifestOf(buildRecipe({
    lat: 44.6995, lon: -73.4529, radius: 2500, seed: '0', gameVersion: '42.20.3', osm: OSM,
  }));
  assert.deepEqual(compareRecipes(mine, theirs), [], 'identical inputs must compare equal');

  const different = manifestOf(buildRecipe({
    lat: 44.6995, lon: -73.4529, radius: 2500, seed: '7', gameVersion: '42.19.0', osm: OSM,
  }));
  const problems = compareRecipes(mine, different);
  assert.ok(problems.some((p) => /seed/.test(p)), `seed difference not reported: ${problems}`);
  assert.ok(problems.some((p) => /42\.20\.3.*42\.19\.0/.test(p)),
    `game version difference not reported: ${problems}`);
});

test('the manifest drops the payload but keeps its size, so it can still be matched', () => {
  const recipe = buildRecipe({ lat: 1, lon: 2, radius: 300, seed: '1', osm: OSM });
  const manifest = manifestOf(recipe);
  assert.equal(manifest.osm, undefined, 'the manifest must not carry the payload');
  assert.equal(manifest.osmBytes, Buffer.byteLength(OSM, 'utf8'));
});

// ---- the property the whole thing rests on --------------------------------

import { findInstall } from '../src/lib/pzinstall.js';

let install = null;
try { install = findInstall(); } catch { install = null; }

const LIBRARY = new URL('../library/buildings.json', import.meta.url);
const haveLibrary = fs.existsSync(LIBRARY);

const skip = !install
  ? 'no Project Zomboid installation found'
  : (!haveLibrary ? 'no extracted building index — run npm run extract' : false);

test('the same inputs build the same world, byte for byte', { skip }, async (t) => {
  const { generateWorld } = await import('../src/emit/generate.js');
  const { loadTileCatalogue } = await import('../src/formats/tiledefs.js');
  const catalogue = loadTileCatalogue(install);
  const library = JSON.parse(fs.readFileSync(LIBRARY, 'utf8')).buildings;

  // A small synthetic town: enough passes to exercise roads, buildings, ground,
  // blends and vegetation, small enough to build twice inside a test.
  const lat = 44.7;
  const lon = -73.45;
  const m = (dx, dy) => [lon + dx / (111320 * Math.cos((lat * Math.PI) / 180)), lat + dy / 110540];
  const features = {
    roads: [
      { kind: 'road', fid: 'a', tags: { highway: 'residential', name: 'First Street' },
        points: [m(-260, 0), m(260, 0)] },
      { kind: 'road', fid: 'b', tags: { highway: 'secondary', name: 'Broad Street' },
        points: [m(0, -260), m(0, 260)] },
    ],
    buildings: [],
    ground: [], objects: [], pois: [],
  };
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const x = -180 + gx * 90;
      const y = -180 + gy * 90;
      features.buildings.push({
        kind: 'building', fid: `h-${gx}-${gy}`, tags: { building: 'house' },
        points: [m(x, y), m(x + 14, y), m(x + 14, y + 12), m(x, y + 12), m(x, y)],
      });
    }
  }

  const dirs = [];
  t.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

  const build = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pzworld-det-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'maps'), { recursive: true });
    generateWorld(features, {
      lat, lon, radiusM: 300, seed: 'determinism', library, catalogue,
      mapDir: dir, canvasSquares: 2048,
    });
    const out = new Map();
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        out.set(path.relative(dir, full).split(path.sep).join('/'),
          crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
      }
    };
    walk(dir);
    return out;
  };

  const first = build();
  const second = build();

  assert.ok(first.size > 0, 'the build produced no files at all');
  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort(),
    'the two builds produced different files');
  const differing = [...first].filter(([name, hash]) => second.get(name) !== hash).map(([n]) => n);
  assert.deepEqual(differing, [],
    'the same inputs produced different bytes, so two players cannot build the same world');
});
