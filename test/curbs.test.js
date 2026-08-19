import test from 'node:test';
import assert from 'node:assert/strict';

import { TileCanvas } from '../src/plan/grid.js';
import {
  classifyRoad,
  createCurbPlan,
  diagonalCurbFacing,
  finalizeCurbs,
  loadRoadProfile,
  markCurbOpening,
  paintRoad,
} from '../src/plan/roads.js';
import { FLOOR_FURNITURE, FLOOR_OVERLAY } from '../src/prefab/layers.js';

const profile = loadRoadProfile();
const world = { builtUp: () => true, inWorld: (x, y) => x >= 0 && y >= 0 && x < 160 && y < 160 };

function urban(points, tags = {}) {
  return { highway: 'residential', tags: { sidewalk: 'both', context: 'urban', ...tags }, points };
}

function curbAt(canvas, x, y) {
  const square = canvas.get(x, y);
  return square?.[FLOOR_FURNITURE] ?? square?.[FLOOR_OVERLAY] ?? null;
}

function renderShared(roads, openings = []) {
  const canvas = new TileCanvas();
  const curbPlan = createCurbPlan();
  for (const road of roads) paintRoad(canvas, road, classifyRoad(road, profile), { ...world, curbPlan }, profile);
  for (const opening of openings) markCurbOpening(curbPlan, ...opening);
  finalizeCurbs(canvas, curbPlan);
  return canvas;
}

test('axis-aligned curb facings match measured vanilla adjacency', () => {
  const horizontal = renderShared([urban([[20, 40], [120, 40]])]);
  assert.equal(curbAt(horizontal, 60, 36), 'street_curbs_01_8');
  assert.equal(curbAt(horizontal, 60, 44), 'street_curbs_01_10');

  const vertical = renderShared([urban([[40, 20], [40, 120]])]);
  assert.equal(curbAt(vertical, 36, 60), 'street_curbs_01_9');
  assert.equal(curbAt(vertical, 44, 60), 'street_curbs_01_11');
});

test('curb openings split runs and produce termination pieces', () => {
  const canvas = renderShared([urban([[20, 50], [120, 50]])], [[70, 46, 2, 'crossing']]);
  for (let x = 68; x <= 72; x++) assert.equal(curbAt(canvas, x, 46), null);
  assert.equal(curbAt(canvas, 67, 46), 'street_curbs_01_8');
  assert.equal(curbAt(canvas, 73, 46), 'street_curbs_01_8');
});

test('crossing carriageways remove curbs from the complete junction mouth', () => {
  const canvas = renderShared([
    urban([[20, 70], [120, 70]]),
    urban([[70, 20], [70, 120]]),
  ]);
  for (let y = 66; y <= 74; y++) {
    for (let x = 66; x <= 74; x++) assert.equal(curbAt(canvas, x, y), null, `curb remained at ${x},${y}`);
  }
});

test('driveway-tagged service transitions open urban curb edges', () => {
  const canvas = renderShared([
    urban([[20, 70], [120, 70]]),
    { highway: 'service', tags: { service: 'driveway', context: 'urban' }, points: [[70, 70], [70, 45]] },
  ]);
  assert.equal(curbAt(canvas, 70, 66), null);
});

test('rural and highway roads never receive default urban curbs', () => {
  for (const road of [
    { highway: 'unclassified', tags: { context: 'rural' }, points: [[20, 50], [120, 50]] },
    { highway: 'motorway', points: [[20, 90], [120, 90]] },
  ]) {
    const canvas = renderShared([road]);
    const curbs = [...canvas.entries()].filter(({ layers }) => layers[FLOOR_FURNITURE]?.startsWith('street_curbs') || layers[FLOOR_OVERLAY]?.startsWith('street_curbs'));
    assert.equal(curbs.length, 0);
  }
});

test('diagonal facings use opposite measured six-piece runs', () => {
  assert.equal(diagonalCurbFacing('nw-se', -1, 1), 'a');
  assert.equal(diagonalCurbFacing('nw-se', 1, -1), 'b');
  const canvas = renderShared([urban([[20, 20], [120, 120]])]);
  const tiles = new Set([...canvas.entries()].flatMap(({ layers }) => layers[FLOOR_OVERLAY] ? [layers[FLOOR_OVERLAY]] : []));
  for (const index of [0, 1, 2, 3, 4, 5, 40, 41, 42, 43, 44, 45]) {
    assert.ok(tiles.has(`street_curbs_01_diag_2_${index}`), `missing diagonal sequence tile ${index}`);
  }
});
