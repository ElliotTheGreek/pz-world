import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NATURAL_SURFACE_PROFILES,
  applyBuildingSurroundings,
  buildSurfaces,
  naturalSurfaceAt,
} from '../src/plan/surfaces.js';
import { SurfaceGrid } from '../src/emit/world.js';
import { terrainFields } from '../src/plan/terrain-fields.js';
import { PLANT_POOLS } from '../src/plan/vegetation.js';

function plan(bounds, polygons = []) {
  return {
    meta: { bounds },
    roads: { ways: [] },
    ground: { polygons },
    builtUp: () => false,
  };
}

test('natural surface profiles are complete measured distributions', () => {
  for (const [pixel, variants] of Object.entries(NATURAL_SURFACE_PROFILES)) {
    const total = variants.reduce((sum, [, weight]) => sum + weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `pixel ${pixel} weights sum to ${total}`);
    assert.ok(variants.length >= 3, `pixel ${pixel} should not paint flat ground`);
  }
});

test('natural terrain is deterministic, varied, and close to measured material shares', () => {
  const fields = terrainFields('natural-ground');
  const counts = new Map();
  let sampled = 0;
  for (let y = 0; y < 1200; y += 3) {
    for (let x = 0; x < 1200; x += 3) {
      const surface = naturalSurfaceAt(255, x, y, fields);
      counts.set(surface, (counts.get(surface) ?? 0) + 1);
      sampled++;
    }
  }

  const rebuilt = terrainFields('natural-ground');
  for (const [x, y] of [[0, 0], [299, 301], [777, 42], [1197, 1197]]) {
    assert.equal(naturalSurfaceAt(255, x, y, fields), naturalSurfaceAt(255, x, y, rebuilt));
  }
  assert.deepEqual(new Set(counts.keys()), new Set(['grass', 'meadow', 'grassLight', 'dirtGrass']));
  for (const [surface, expected] of NATURAL_SURFACE_PROFILES[255]) {
    const actual = (counts.get(surface) ?? 0) / sampled;
    assert.ok(Math.abs(actual - expected) < 0.08, `${surface}: expected ${expected}, got ${actual}`);
  }
});

test('surface painting preserves water, farmland, parking, and authored ownership', () => {
  const bounds = { minX: 0, minY: 0, maxX: 39, maxY: 39 };
  const square = (x, y, size, pixel, area = size * size) => ({
    pixel,
    area,
    points: [[x, y], [x + size, y], [x + size, y + size], [x, y + size]],
  });
  const surfaces = buildSurfaces(plan(bounds, [
    square(2, 2, 6, 0),
    square(12, 2, 6, 141),
    square(22, 2, 6, 200),
    square(2, 14, 8, 64),
  ]), { seed: 'ownership' });

  assert.equal(surfaces.get(4, 4), 'water');
  assert.equal(surfaces.ownerAt(4, 4), 'water');
  assert.equal(surfaces.get(14, 4), 'grassLight');
  assert.equal(surfaces.ownerAt(14, 4), 'farmland');
  assert.equal(surfaces.get(24, 4), 'road');
  assert.equal(surfaces.ownerAt(24, 4), 'built');
  assert.equal(surfaces.ownerAt(4, 16), 'managed');

  const natural = new Set();
  for (let y = 25; y < 40; y++) {
    for (let x = 0; x < 40; x++) natural.add(surfaces.get(x, y));
  }
  assert.ok(natural.size > 1, `default wilderness was flat: ${[...natural]}`);
});

test('building surroundings use registry classes and never enter another footprint', () => {
  const surfaces = new SurfaceGrid({ minX: 0, minY: 0, maxX: 31, maxY: 23 });
  surfaces.fill('grass', 'natural');
  const buildings = [
    { x: 5, y: 7, w: 4, h: 4, cls: 'gas_station', requestedClass: 'gas_station', tags: {} },
    // Deliberately within the three-square apron radius of the first building.
    { x: 10, y: 7, w: 4, h: 4, cls: 'house', requestedClass: 'house', tags: {} },
  ];

  const painted = applyBuildingSurroundings(surfaces, buildings);
  assert.ok(painted > 0);
  assert.equal(surfaces.get(4, 8), 'road', 'automotive structures need a vehicle apron');
  assert.equal(surfaces.ownerAt(4, 8), 'built');
  assert.equal(surfaces.get(10, 8), 'grass', 'an apron must not enter a neighboring footprint');
  assert.equal(surfaces.ownerAt(10, 8), 'natural', 'footprint ownership must remain untouched');
  assert.equal(surfaces.ownerAt(14, 8), 'managed', 'a house keeps a permeable managed yard');
});

test('private vehicle sites retain permeable managed ground instead of public apron', () => {
  const surfaces = new SurfaceGrid({ minX: 0, minY: 0, maxX: 19, maxY: 19 });
  surfaces.fill('grass', 'natural');
  applyBuildingSurroundings(surfaces, [
    {
      x: 7, y: 7, w: 4, h: 4,
      cls: 'industrial', requestedClass: 'industrial',
      tags: { access: 'private' },
    },
  ]);

  assert.equal(surfaces.get(6, 8), 'grass');
  assert.equal(surfaces.ownerAt(6, 8), 'managed');
});

test('contextual foliage pools exclude incompatible authored uses', () => {
  assert.ok(PLANT_POOLS.wild.totalWeight > PLANT_POOLS.managed.totalWeight);
  assert.equal(PLANT_POOLS.managed.boulders.length, 0);
  assert.ok(PLANT_POOLS.managed.cumulative.every(({ tile }) => !tile.startsWith('vegetation_farm_')));
  assert.ok(PLANT_POOLS.town.cumulative.every(({ tile }) => !tile.startsWith('vegetation_farm_')));
});
