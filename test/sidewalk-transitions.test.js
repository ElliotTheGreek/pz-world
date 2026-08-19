import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRoad,
  createCurbPlan,
  finalizeCurbs,
  finalizeSidewalks,
  loadRoadProfile,
  markCurbOpening,
  paintRoad,
} from '../src/plan/roads.js';
import { TileCanvas } from '../src/plan/grid.js';
import { FLOOR, FLOOR_OVERLAY } from '../src/prefab/layers.js';

const profile = loadRoadProfile();
const ASPHALT = 'blends_street_01_86';
const PAVEMENT_PREFIX = 'floors_exterior_tilesandstone_01_';
const GRASS_BLEND_PREFIX = 'blends_natural_01_';
const context = {
  builtUp: () => true,
  inWorld: (x, y) => x >= 0 && y >= 0 && x < 160 && y < 160,
};

function render(road, { openings = [], buildingFootprint = [] } = {}) {
  const canvas = new TileCanvas();
  const curbPlan = createCurbPlan();
  for (const key of buildingFootprint) curbPlan.buildingFootprint.add(key);
  paintRoad(canvas, road, classifyRoad(road, profile), { ...context, curbPlan }, profile);
  for (const opening of openings) markCurbOpening(curbPlan, ...opening);
  finalizeSidewalks(canvas, curbPlan);
  finalizeCurbs(canvas, curbPlan);
  return { canvas, curbPlan };
}

function pavementEntries(canvas) {
  return [...canvas.entries()].filter(({ layers }) => layers[FLOOR]?.startsWith(PAVEMENT_PREFIX));
}

test('straight sidewalks use varied pavement and fuzzy grass artwork at outer edges', () => {
  const { canvas } = render({
    highway: 'residential',
    tags: { sidewalk: 'both', context: 'urban', 'sidewalk:surface': 'concrete' },
    points: [[20, 70], [130, 70]],
  });
  const pavement = pavementEntries(canvas);
  assert.ok(pavement.length > 100, 'sidewalk body was not painted');
  assert.ok(new Set(pavement.map(({ layers }) => layers[FLOOR])).size >= 2,
    'concrete pavement did not use deterministic context variants');
  assert.ok(pavement.some(({ layers }) => layers[FLOOR_OVERLAY]?.startsWith(GRASS_BLEND_PREFIX)),
    'outer verge has no fuzzy grass blend artwork');
  assert.ok(pavement.some(({ x, y }) => x <= 20 || x >= 130 || y <= 64 || y >= 76),
    'rounded sidewalk ends were not retained');
});

test('bent sidewalks emit inner/outer corner verge artwork and rounded end caps', () => {
  const { canvas } = render({
    highway: 'residential',
    tags: { sidewalk: 'both', context: 'urban' },
    points: [[25, 75], [75, 75], [75, 125]],
  });
  const overlays = pavementEntries(canvas)
    .map(({ layers }) => layers[FLOOR_OVERLAY])
    .filter(Boolean);
  assert.ok(overlays.some((tile) =>
    ['blends_natural_01_33', 'blends_natural_01_34',
      'blends_natural_01_35', 'blends_natural_01_36'].includes(tile)),
  'bend did not emit grass inner-corner artwork');
  assert.ok(pavementEntries(canvas).some(({ x, y }) =>
    Math.hypot(x - 25, y - 75) > 4 && Math.hypot(x - 25, y - 75) <= 6),
  'sidewalk end did not retain its rounded transition cap');
});

test('diagonal sidewalks remain continuous and receive diagonal-edge verge artwork', () => {
  const { canvas, curbPlan } = render({
    highway: 'residential',
    tags: { sidewalk: 'both', context: 'urban' },
    points: [[25, 25], [115, 115]],
  });
  assert.ok(curbPlan.sidewalkCandidates.every((candidate) => candidate.diagonal),
    '45-degree candidates were not classified as diagonal');
  const pavement = pavementEntries(canvas);
  assert.ok(pavement.length > 150, 'diagonal sidewalk is discontinuous or absent');
  assert.ok(pavement.some(({ layers }) => layers[FLOOR_OVERLAY]?.startsWith(GRASS_BLEND_PREFIX)),
    'diagonal verge edge has no feathered artwork');
});

test('driveway and crossing cuts preserve pavement transitions but remove curbs and grass fringe', () => {
  const road = {
    highway: 'residential',
    tags: { sidewalk: 'both', context: 'urban' },
    points: [[20, 70], [130, 70]],
  };
  const { canvas } = render(road, {
    openings: [[55, 65, 2, 'driveway'], [95, 75, 2, 'crossing']],
  });
  for (const [x, y] of [[55, 65], [95, 75]]) {
    assert.ok(canvas.get(x, y)?.[FLOOR], `transition pavement missing at ${x},${y}`);
    assert.equal(canvas.get(x, y)?.[FLOOR_OVERLAY], undefined,
      `grass or curb overlay collides with transition at ${x},${y}`);
  }
});

test('sidewalk finalization cannot overwrite carriageways or placed building footprints', () => {
  const horizontal = {
    highway: 'residential', tags: { sidewalk: 'both', context: 'urban' },
    points: [[15, 75], [145, 75]],
  };
  const vertical = {
    highway: 'residential', tags: { sidewalk: 'both', context: 'urban' },
    points: [[80, 15], [80, 145]],
  };
  const canvas = new TileCanvas();
  const curbPlan = createCurbPlan();
  for (let y = 68; y <= 72; y++) for (let x = 105; x <= 112; x++) {
    curbPlan.buildingFootprint.add(`${x},${y}`);
  }
  for (const road of [horizontal, vertical]) {
    paintRoad(canvas, road, classifyRoad(road, profile), { ...context, curbPlan }, profile);
  }
  finalizeSidewalks(canvas, curbPlan);
  finalizeCurbs(canvas, curbPlan);

  assert.equal(canvas.get(80, 75)?.[FLOOR], ASPHALT,
    'sidewalk overwrote the crossing carriageway');
  for (let y = 68; y <= 72; y++) for (let x = 105; x <= 112; x++) {
    assert.ok(!canvas.get(x, y)?.[FLOOR]?.startsWith(PAVEMENT_PREFIX),
      `sidewalk collided with building footprint at ${x},${y}`);
  }
});

test('tagged sidewalk surfaces select context-appropriate artwork', () => {
  const pavers = render({
    highway: 'residential',
    tags: { sidewalk: 'both', context: 'urban', 'sidewalk:surface': 'paving_stones' },
    points: [[20, 50], [130, 50]],
  }).canvas;
  const gravel = render({
    highway: 'residential',
    tags: { sidewalk: 'both', context: 'urban', 'sidewalk:surface': 'gravel' },
    points: [[20, 100], [130, 100]],
  }).canvas;
  assert.ok(pavementEntries(pavers).some(({ layers }) =>
    ['floors_exterior_tilesandstone_01_0', 'floors_exterior_tilesandstone_01_1'].includes(layers[FLOOR])));
  assert.ok([...gravel.entries()].some(({ layers }) => layers[FLOOR] === 'blends_street_01_54'));
});
