import test from 'node:test';
import assert from 'node:assert/strict';

import { TileCanvas } from '../src/plan/grid.js';
import {
  classifyRoadsideFeature,
  planRoadsideFeatures,
  renderRoadsideFeatures,
} from '../src/plan/roadside.js';
import { FURNITURE } from '../src/prefab/layers.js';

function emptyPlan() {
  return { carriageway: new Set(), buildingFootprint: new Set() };
}

function markRoad(plan, minX, maxX, minY, maxY) {
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) plan.carriageway.add(`${x},${y}`);
  }
}

const horizontalRoad = {
  fid: 'road-main', name: 'Main Street', tags: { name: 'Main Street' },
  points: [[0, 10], [30, 10]], spec: { width: 4 },
};

test('classifies retained traffic controls, route context, and supported furniture', () => {
  assert.equal(classifyRoadsideFeature({ kind: 'sign', tags: { highway: 'stop' } }), 'stop');
  assert.equal(classifyRoadsideFeature({ kind: 'sign', tags: { traffic_sign: 'US:R1-2' } }), 'give_way');
  assert.equal(classifyRoadsideFeature({ kind: 'signals', tags: {} }), 'traffic_signals');
  assert.equal(classifyRoadsideFeature({ kind: 'crossing', tags: {} }), 'crossing');
  assert.equal(classifyRoadsideFeature({ kind: 'junction', tags: { highway: 'motorway_junction', ref: '42' } }), 'route');
  assert.equal(classifyRoadsideFeature({ kind: 'street-furniture', tags: { highway: 'street_lamp' } }), 'street_lamp');
  assert.equal(classifyRoadsideFeature({ kind: 'barrier', tags: { barrier: 'bollard' } }), 'bollard');
});

test('explicit stop signs are oriented to the approach and moved out of travel lanes', () => {
  const curbPlan = emptyPlan();
  markRoad(curbPlan, 0, 30, 8, 12);
  const objects = [{
    fid: 'stop-1', kind: 'sign', points: [[15, 10]],
    tags: { highway: 'stop', direction: 'forward' },
  }];
  const first = planRoadsideFeatures({ objects, roads: [horizontalRoad], curbPlan });
  const second = planRoadsideFeatures({ objects, roads: [horizontalRoad], curbPlan });

  assert.deepEqual(first, second, 'placement must be deterministic');
  assert.equal(first.placements.length, 1);
  const [sign] = first.placements;
  assert.equal(sign.kind, 'stop');
  assert.equal(sign.facing, 'west');
  assert.equal(sign.source, 'osm');
  assert.equal(curbPlan.carriageway.has(`${sign.x},${sign.y}`), false);
  assert.ok(Math.abs(sign.y - 10) >= 3);

  const canvas = new TileCanvas();
  assert.equal(renderRoadsideFeatures(canvas, first), 1);
  assert.equal(canvas.get(sign.x, sign.y)[FURNITURE], 'street_decoration_01_3');
});

test('crossing, route, and lamp nodes use supported mappings without lane placement', () => {
  const curbPlan = emptyPlan();
  markRoad(curbPlan, 0, 30, 8, 12);
  const objects = [
    { fid: 'cross', kind: 'crossing', points: [[8, 10]], tags: { highway: 'crossing' } },
    { fid: 'route', kind: 'junction', points: [[15, 10]], tags: { highway: 'motorway_junction', ref: '17' } },
    { fid: 'lamp', kind: 'street-furniture', points: [[22, 10]], tags: { highway: 'street_lamp' } },
  ];
  const roadside = planRoadsideFeatures({ objects, roads: [horizontalRoad], curbPlan });
  assert.deepEqual(roadside.placements.map(({ kind }) => kind).sort(), ['crossing', 'route', 'street_lamp']);
  assert.ok(roadside.placements.every(({ x, y }) => !curbPlan.carriageway.has(`${x},${y}`)));

  const canvas = new TileCanvas();
  assert.equal(renderRoadsideFeatures(canvas, roadside), 3);
  assert.ok(roadside.placements.every(({ tile }) => typeof tile === 'string'));
});

test('tagged major road ways receive deterministic route-context signs', () => {
  const curbPlan = emptyPlan();
  markRoad(curbPlan, 0, 30, 8, 12);
  const routeRoad = {
    ...horizontalRoad,
    fid: 'route-way',
    tags: { name: 'State Road', ref: 'KY 17' },
    spec: { width: 4, hierarchy: 'arterial' },
  };
  const roadside = planRoadsideFeatures({ roads: [routeRoad], curbPlan });
  assert.equal(roadside.placements.length, 1);
  assert.equal(roadside.placements[0].kind, 'route');
  assert.equal(roadside.placements[0].routeRef, 'KY 17');
  assert.equal(curbPlan.carriageway.has(`${roadside.placements[0].x},${roadside.placements[0].y}`), false);
});

test('junction inference stops only a lower-class terminating arm', () => {
  const curbPlan = emptyPlan();
  markRoad(curbPlan, 30, 70, 47, 53);
  markRoad(curbPlan, 47, 53, 50, 75);
  const service = {
    fid: 'service', tags: { name: 'Depot Lane' }, points: [[50, 50], [50, 75]], spec: { width: 4 },
  };
  const arterial = {
    fid: 'arterial', tags: { name: 'County Road' }, points: [[30, 50], [70, 50]], spec: { width: 6 },
  };
  const intersection = {
    x: 50, y: 50, radius: 4, topology: 't-junction',
    arms: [
      { dx: -1, dy: 0, width: 6, hierarchy: 'arterial', road: arterial },
      { dx: 1, dy: 0, width: 6, hierarchy: 'arterial', road: arterial },
      { dx: 0, dy: 1, width: 4, hierarchy: 'service', road: service },
    ],
  };
  const roadside = planRoadsideFeatures({
    roads: [arterial, service], intersections: [intersection], curbPlan,
  });
  const inferred = roadside.placements.filter((placement) => placement.inferred);
  assert.equal(inferred.length, 1);
  assert.equal(inferred[0].kind, 'stop');
  assert.equal(inferred[0].junction, 't-junction');
  assert.equal(curbPlan.carriageway.has(`${inferred[0].x},${inferred[0].y}`), false);
});

test('equal-class T junctions remain uncontrolled and explicit controls suppress inference', () => {
  const base = {
    x: 20, y: 20, radius: 3, topology: 't-junction',
    arms: [
      { dx: -1, dy: 0, width: 4, hierarchy: 'residential', road: horizontalRoad },
      { dx: 1, dy: 0, width: 4, hierarchy: 'residential', road: horizontalRoad },
      { dx: 0, dy: 1, width: 4, hierarchy: 'residential', road: horizontalRoad },
    ],
  };
  assert.equal(planRoadsideFeatures({ intersections: [base], curbPlan: emptyPlan() }).stats.inferred, 0);

  const curbPlan = emptyPlan();
  markRoad(curbPlan, 0, 30, 8, 12);
  const explicit = [{ fid: 'tagged-stop', kind: 'sign', points: [[20, 10]], tags: { highway: 'stop' } }];
  const controlled = { ...base, x: 20, y: 10 };
  const result = planRoadsideFeatures({
    objects: explicit, roads: [horizontalRoad], intersections: [controlled], curbPlan,
  });
  assert.equal(result.placements.filter((placement) => placement.kind === 'stop').length, 1);
  assert.equal(result.stats.inferred, 0);
});

test('named intersecting roads produce one street-name sign outside the carriageway', () => {
  const curbPlan = emptyPlan();
  markRoad(curbPlan, 15, 25, 18, 22);
  markRoad(curbPlan, 18, 22, 15, 25);
  const intersection = {
    x: 20, y: 20, radius: 3, topology: 'four-way',
    arms: [
      { road: { tags: { name: 'Oak Street' } } },
      { road: { tags: { name: 'Oak Street' } } },
      { road: { tags: { name: 'First Avenue' } } },
      { road: { tags: { name: 'First Avenue' } } },
    ],
  };
  const roadside = planRoadsideFeatures({ intersections: [intersection], curbPlan });
  const sign = roadside.placements.find((placement) => placement.kind === 'street_name');
  assert.deepEqual(sign.streetNames, ['First Avenue', 'Oak Street']);
  assert.equal(curbPlan.carriageway.has(`${sign.x},${sign.y}`), false);
});
