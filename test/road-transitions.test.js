import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cardinalFromVector,
  classifyRoad,
  loadRoadProfile,
  nearestPolylinePoint,
  paintRoad,
  polylineBounds,
  selectCurbSequenceVariant,
} from '../src/plan/roads.js';
import { TileCanvas } from '../src/plan/grid.js';
import { FLOOR, FLOOR_OVERLAY } from '../src/prefab/layers.js';

const profile = loadRoadProfile();
const context = {
  builtUp: () => true,
  inWorld: (x, y) => x >= 0 && y >= 0 && x < 180 && y < 180,
};

function render(points) {
  const road = { highway: 'residential', tags: { sidewalk: 'both', context: 'urban' }, points };
  const canvas = new TileCanvas();
  const writes = paintRoad(canvas, road, classifyRoad(road, profile), context, profile);
  return { canvas, writes };
}

function layerTiles(canvas, layer) {
  return [...canvas.entries()].flatMap(({ layers }) => layers[layer] ? [layers[layer]] : []);
}

test('nearest polyline samples retain local bearing and cumulative run position', () => {
  const points = [[10, 10], [50, 10], [80, 40]];
  const straight = nearestPolylinePoint(points, 30, 14);
  const diagonal = nearestPolylinePoint(points, 65, 29);

  assert.deepEqual([straight.dx, straight.dy], [40, 0]);
  assert.deepEqual([diagonal.dx, diagonal.dy], [30, 30]);
  assert.ok(diagonal.along > 40, 'position did not continue across the bend');
  assert.equal(cardinalFromVector(straight.towardX, straight.towardY), 'north');
});

test('polyline scan bounds include rounded caps and bend exterior', () => {
  assert.deepEqual(polylineBounds([[20, 20], [50, 20], [50, 60]], 5), {
    minX: 15,
    minY: 15,
    maxX: 55,
    maxY: 65,
  });
});

test('diagonal curb selector emits a complete directional cycle on both edges', () => {
  const mapping = {
    when: { orientation: 'nw-se' },
    variants: [0, 1, 2, 3].map((index) => ({ tile: `diag_${index}` })),
  };
  const forward = [0, 1, 2, 3].map((step) =>
    selectCurbSequenceVariant(mapping, step * Math.SQRT2, -1, 1));
  const reverse = [0, 1, 2, 3].map((step) =>
    selectCurbSequenceVariant(mapping, step * Math.SQRT2, 1, -1));

  assert.equal(new Set(forward).size, 4, 'one diagonal sprite was repeated');
  assert.equal(new Set(reverse).size, 4, 'opposite edge did not use the full sequence');
  assert.deepEqual(forward, ['diag_0', 'diag_1', 'diag_3', 'diag_2']);
  assert.deepEqual(reverse, ['diag_0', 'diag_2', 'diag_3', 'diag_1']);
});

test('rounded bend rasterization leaves no carriageway notch at the vertex', () => {
  const { canvas, writes } = render([[25, 75], [75, 75], [75, 125]]);
  assert.ok(writes > 0);

  // Residential fallback width is six squares, so every integer point within
  // three squares of the shared vertex belongs to the rounded carriageway.
  for (let y = 72; y <= 78; y++) {
    for (let x = 72; x <= 78; x++) {
      if (Math.hypot(x - 75, y - 75) > 3) continue;
      assert.ok(canvas.get(x, y)?.[FLOOR], `missing bend surface at ${x},${y}`);
    }
  }
});

test('both diagonal bearings use complete validated curb artwork families', () => {
  const positive = render([[25, 25], [105, 105]]).canvas;
  const negative = render([[25, 105], [105, 25]]).canvas;
  const positiveTiles = new Set(layerTiles(positive, FLOOR_OVERLAY).filter((tile) => tile.startsWith('street_curbs_01_diag')));
  const negativeTiles = new Set(layerTiles(negative, FLOOR_OVERLAY).filter((tile) => tile.startsWith('street_curbs_01_diag')));

  assert.deepEqual(positiveTiles, new Set([
    ...[0, 1, 2, 3, 4, 5].map((index) => `street_curbs_01_diag_2_${index}`),
    ...[40, 41, 42, 43, 44, 45].map((index) => `street_curbs_01_diag_2_${index}`),
  ]));
  assert.deepEqual(negativeTiles, new Set([
    ...[0, 1, 2, 3, 4, 5].map((index) => `street_curbs_01_diag_${index}`),
    ...[40, 41, 42, 43, 44, 45].map((index) => `street_curbs_01_diag_${index}`),
  ]));
});
