import assert from 'node:assert/strict';
import test from 'node:test';

import { TileCanvas } from '../src/plan/grid.js';
import {
  classifyRoad,
  isRuralRoad,
  loadRoadProfile,
  paintRoad,
  ruralSurfaceMaterial,
} from '../src/plan/roads.js';
import { FLOOR, FLOOR_FURNITURE, FLOOR_OVERLAY } from '../src/prefab/layers.js';

const profile = loadRoadProfile();
const ASPHALT = 'blends_street_01_86';
const GRAVEL = 'blends_street_01_54';
const DIRT = 'blends_natural_01_64';
const DITCH = 'blends_natural_01_16';
const VERGE = 'blends_natural_01_32';
const SIDEWALK = 'floors_exterior_tilesandstone_01_3';
const EW_LINE = 'street_trafficlines_01_6';

function render(highway, tags = {}, builtUp = () => false) {
  const canvas = new TileCanvas();
  const road = { highway, tags, points: [[20, 50], [100, 50]] };
  const spec = classifyRoad(road, profile);
  const writes = paintRoad(canvas, road, spec, {
    builtUp,
    inWorld: (x, y) => x >= 0 && y >= 0 && x < 140 && y < 100,
  }, profile);
  return { canvas, road, spec, writes };
}

function layerTiles(canvas, layer) {
  return [...canvas.entries()].map((entry) => entry.layers[layer]).filter(Boolean);
}

function floorColumn(canvas, x, from, to) {
  const out = [];
  for (let y = from; y <= to; y++) out.push(canvas.get(x, y)?.[FLOOR] ?? null);
  return out;
}

function assertNoUrbanEdges(canvas) {
  assert.equal(layerTiles(canvas, FLOOR_FURNITURE).length, 0, 'rural road received a curb');
  assert.ok(!layerTiles(canvas, FLOOR).includes(SIDEWALK), 'rural road received a sidewalk');
}

test('an unclassified rural road has paved core, aggregate shoulders, ditches, and grassy verges', () => {
  const { canvas, spec, writes } = render('unclassified');
  assert.ok(writes > 0);
  assert.equal(spec.width, 6);
  assert.deepEqual(
    floorColumn(canvas, 60, 44, 55),
    [VERGE, DITCH, GRAVEL, ASPHALT, ASPHALT, ASPHALT, ASPHALT, ASPHALT, ASPHALT, GRAVEL, DITCH, VERGE],
  );
  assert.equal(layerTiles(canvas, FLOOR_OVERLAY).length, 0, 'quiet rural fallback invented markings');
  assertNoUrbanEdges(canvas);
});

test('tracks and explicit loose surfaces select narrow unpaved artwork', () => {
  const track = render('track');
  assert.equal(track.spec.width, 3);
  assert.deepEqual(floorColumn(track.canvas, 60, 48, 52), [VERGE, GRAVEL, GRAVEL, GRAVEL, VERGE]);
  assertNoUrbanEdges(track.canvas);

  const dirt = render('service', { surface: 'earth', rural: 'yes' });
  assert.equal(ruralSurfaceMaterial(dirt.road, dirt.spec), 'dirt');
  assert.ok(layerTiles(dirt.canvas, FLOOR).includes(DIRT));
  assert.ok(!layerTiles(dirt.canvas, FLOOR).includes(ASPHALT));
  assertNoUrbanEdges(dirt.canvas);
});

test('land context distinguishes rural and urban instances of the same road class', () => {
  const road = { highway: 'secondary', points: [[0, 0], [20, 0]] };
  const spec = classifyRoad(road, profile);
  assert.equal(isRuralRoad(road, spec, { builtUp: () => false }), true);
  assert.equal(isRuralRoad(road, spec, { builtUp: () => true }), false);
  assert.equal(isRuralRoad({ ...road, tags: { landuse: 'farmland' } }, spec, { builtUp: () => true }), true);
  assert.equal(isRuralRoad({ ...road, tags: { context: 'urban' } }, spec, { builtUp: () => false }), false);
});

test('major paved rural roads carry an unbroken centre line and respect OSM suppression', () => {
  // The line is continuous, not dashed. Vanilla's two-lane roads carry an
  // unbroken yellow line, and a repeating dash also came apart off the grid
  // axes: consecutive squares of a diagonal run advance along the centreline by
  // √2, so an integer repeat skipped values and the result was ragged rather
  // than dashed. A dashed lane divider still belongs on a motorway, where
  // `highwayArtwork` owns it.
  const marked = render('secondary');
  const overlays = layerTiles(marked.canvas, FLOOR_OVERLAY);
  assert.ok(overlays.includes(EW_LINE), 'rural secondary lacks its centre marking');
  assert.equal(overlays.length, 81, 'the centre line has gaps in it');
  assert.equal(new Set(overlays).size, 1, 'the centre line is not one sprite end to end');
  assertNoUrbanEdges(marked.canvas);

  const unmarked = render('secondary', { markings: 'no' });
  assert.equal(layerTiles(unmarked.canvas, FLOOR_OVERLAY).length, 0);
});

test('explicit shoulder and ditch tags override rural defaults', () => {
  const noBands = render('unclassified', { shoulder: 'no', ditch: 'no' });
  const floors = floorColumn(noBands.canvas, 60, 44, 55);
  assert.ok(!floors.includes(GRAVEL), 'shoulder=no was ignored');
  assert.ok(!floors.includes(DITCH), 'ditch=no was ignored');
  assert.ok(floors.includes(VERGE));

  const trackDitch = render('track', { ditch: 'yes' });
  assert.ok(layerTiles(trackDitch.canvas, FLOOR).includes(DITCH), 'explicit track ditch was not rendered');
});
