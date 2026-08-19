import assert from 'node:assert/strict';
import test from 'node:test';

import { TileCanvas } from '../src/plan/grid.js';
import { classifyRoad, loadRoadProfile, paintRoad } from '../src/plan/roads.js';
import { FLOOR, FLOOR_FURNITURE, FLOOR_OVERLAY } from '../src/prefab/layers.js';

const profile = loadRoadProfile();
const ASPHALT = 'blends_street_01_86';
// There is no gravel shoulder. `media/lua/server/WorldGen/prefabs/highway_NS_00.lua`
// is vanilla's own highway cross-section, and across its 20 columns it lays
// blends_street_01_86 for all fifteen paved squares — carriageway and hard
// shoulder alike — with a solid edge line marking where the running lanes stop.
// A tan shoulder was worse than merely wrong: each carriageway of a divided
// motorway is a separate OSM way, so the two inner shoulders met and filled the
// median gap with gravel.
const EDGE_LINE = 'street_trafficlines_01_22';
const MEDIAN = 'blends_natural_01_16';
const VERGE = 'blends_natural_01_32';
const SIDEWALK = 'floors_exterior_tilesandstone_01_3';
const NS_LINE = 'street_trafficlines_01_20';
const EW_LINE = 'street_trafficlines_01_22';

const context = {
  builtUp: () => true,
  inWorld: (x, y) => x >= 0 && y >= 0 && x < 200 && y < 200,
};

function render(highway, points, tags = {}) {
  const canvas = new TileCanvas();
  const road = { highway, tags, points };
  const spec = classifyRoad(road, profile);
  const writes = paintRoad(canvas, road, spec, context, profile);
  return { canvas, spec, writes };
}

function floorsInColumn(canvas, x, lo, hi) {
  const out = [];
  for (let y = lo; y <= hi; y++) out.push(canvas.get(x, y)?.[FLOOR] ?? null);
  return out;
}

function tiles(canvas, layer) {
  return [...canvas.entries()].map((entry) => entry.layers[layer]).filter(Boolean);
}

function assertNoUrbanArtwork(canvas) {
  assert.ok(!tiles(canvas, FLOOR).includes(SIDEWALK), 'highway received an urban sidewalk');
  assert.equal(tiles(canvas, FLOOR_FURNITURE).length, 0, 'highway received an urban curb');
}

test('a straight highway has exact carriageway, median, shoulder, and verge bands', () => {
  const { canvas, spec, writes } = render('motorway', [[20, 50], [100, 50]]);
  assert.ok(writes > 0);
  assert.equal(spec.lanes, 4);
  assert.equal(spec.coreWidth, 14);
  assert.equal(spec.median.width, 2);
  assert.deepEqual(
    floorsInColumn(canvas, 60, 38, 61),
    [VERGE, VERGE, ASPHALT, ASPHALT,
      ASPHALT, ASPHALT, ASPHALT, ASPHALT, ASPHALT, ASPHALT, ASPHALT,
      MEDIAN, MEDIAN,
      ASPHALT, ASPHALT, ASPHALT, ASPHALT, ASPHALT, ASPHALT, ASPHALT,
      ASPHALT, ASPHALT, VERGE, VERGE],
  );
  assert.ok(tiles(canvas, FLOOR_OVERLAY).includes(EW_LINE), 'highway lacks longitudinal markings');
  // The paved band reads as carriageway-plus-shoulder because a continuous edge
  // line separates them, which is the only thing that distinguishes the two in
  // vanilla either.
  const edges = [...canvas.entries()]
    .filter((e) => e.layers[FLOOR_OVERLAY] === EDGE_LINE && e.x === 60)
    .map((e) => e.y)
    .sort((a, b) => a - b);
  assert.deepEqual(edges, [42, 57], 'the carriageway has no continuous edge line');
  assertNoUrbanArtwork(canvas);
});

test('highway bends keep broad bands and rotate cardinal line artwork per segment', () => {
  const { canvas } = render('trunk', [[20, 50], [90, 50], [90, 120]]);
  const overlays = tiles(canvas, FLOOR_OVERLAY);
  assert.ok(overlays.includes(EW_LINE), 'horizontal leg lacks highway lines');
  assert.ok(overlays.includes(NS_LINE), 'vertical leg lacks highway lines');
  assert.equal(canvas.get(55, 50)?.[FLOOR], MEDIAN, 'horizontal median is discontinuous');
  assert.equal(canvas.get(90, 90)?.[FLOOR], MEDIAN, 'vertical median is discontinuous');
  assertNoUrbanArtwork(canvas);
});

test('motorway links render as narrow median-free ramps with highway shoulders and verges', () => {
  const { canvas, spec } = render('motorway_link', [[20, 40], [100, 40]], { oneway: 'yes' });
  assert.equal(spec.lanes, 1);
  assert.equal(spec.median.presence, 'none');
  assert.ok(floorsInColumn(canvas, 60, 30, 50).includes(ASPHALT));
  assert.ok(floorsInColumn(canvas, 60, 30, 50).includes(VERGE));
  // A ramp is paved wider than its single running lane, and the extra is the
  // hard shoulder — the same asphalt, bounded by the edge line rather than by a
  // change of material.
  const paved = floorsInColumn(canvas, 60, 30, 50).filter((tile) => tile === ASPHALT).length;
  assert.ok(paved > spec.coreWidth, `ramp has no hard shoulder (${paved} paved, lane ${spec.coreWidth})`);
  assert.ok(tiles(canvas, FLOOR_OVERLAY).includes(EDGE_LINE), 'ramp lacks its edge lines');
  assert.ok(!floorsInColumn(canvas, 60, 30, 50).includes(MEDIAN));
  assertNoUrbanArtwork(canvas);
});

test('a ramp merge remains connected while retaining mainline and ramp cross-sections', () => {
  const canvas = new TileCanvas();
  const main = { highway: 'motorway', points: [[15, 80], [150, 80]] };
  const ramp = { highway: 'motorway_link', tags: { oneway: 'yes' }, points: [[30, 115], [75, 82], [125, 80]] };
  paintRoad(canvas, main, classifyRoad(main, profile), context, profile);
  paintRoad(canvas, ramp, classifyRoad(ramp, profile), context, profile);

  assert.equal(canvas.get(45, 104)?.[FLOOR], ASPHALT, 'ramp approach is missing');
  assert.equal(canvas.get(110, 80)?.[FLOOR], ASPHALT, 'merge conflict area is not paved');
  assert.ok(tiles(canvas, FLOOR).includes(MEDIAN), 'mainline median disappeared at merge');
  assertNoUrbanArtwork(canvas);
});

test('crossing highway junctions retain highway bands and markings on both axes', () => {
  const canvas = new TileCanvas();
  const horizontal = { highway: 'motorway', points: [[15, 80], [145, 80]] };
  const vertical = { highway: 'trunk', points: [[80, 15], [80, 145]] };
  paintRoad(canvas, horizontal, classifyRoad(horizontal, profile), context, profile);
  paintRoad(canvas, vertical, classifyRoad(vertical, profile), context, profile);

  const overlays = tiles(canvas, FLOOR_OVERLAY);
  assert.ok(overlays.includes(EW_LINE));
  assert.ok(overlays.includes(NS_LINE));
  assert.ok(canvas.get(80, 80)?.[FLOOR], 'junction conflict area has a hole');
  assertNoUrbanArtwork(canvas);
});

test('highways remain visually distinct from built-up residential streets', () => {
  const highway = render('motorway', [[20, 50], [100, 50]]).canvas;
  const street = render('residential', [[20, 100], [100, 100]]).canvas;

  assert.ok(tiles(highway, FLOOR).includes(MEDIAN));
  assert.ok(tiles(highway, FLOOR).includes(VERGE));
  assert.ok(tiles(highway, FLOOR_OVERLAY).includes(EDGE_LINE), 'highway lacks its edge lines');
  assert.ok(!tiles(street, FLOOR_OVERLAY).includes(EDGE_LINE), 'a city street got highway edge lines');
  assertNoUrbanArtwork(highway);
  assert.ok(tiles(street, FLOOR).includes(SIDEWALK), 'city street lacks its expected sidewalk');
  assert.ok(tiles(street, FLOOR_FURNITURE).length > 0, 'city street lacks its expected curb');
  assert.ok(highway.size > street.size, 'highway is not geometrically wider than city street');
});
