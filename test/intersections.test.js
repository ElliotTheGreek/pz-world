import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIntersectionTopology,
  classifyIntersectionTopology,
  classifyRoad,
  createCurbPlan,
  loadRoadProfile,
  renderIntersections,
} from '../src/plan/roads.js';
import { TileCanvas } from '../src/plan/grid.js';
import { FLOOR, FLOOR_FURNITURE, FLOOR_OVERLAY } from '../src/prefab/layers.js';

const profile = loadRoadProfile();
const arm = (dx, dy, extra = {}) => ({ dx, dy, width: 6, ...extra });

test('classifies every supported intersection topology from incident arms', () => {
  assert.equal(classifyIntersectionTopology([arm(1, 0)]), 'dead-end');
  assert.equal(classifyIntersectionTopology([arm(-1, 0), arm(1, 0)]), 'straight');
  assert.equal(classifyIntersectionTopology([arm(-1, 0), arm(0, 1)]), 'bend');
  assert.equal(classifyIntersectionTopology([arm(-1, -0.2), arm(-1, 0.2)]), 'merge');
  assert.equal(classifyIntersectionTopology([arm(-1, 0), arm(1, 0), arm(0, 1)]), 't-junction');
  assert.equal(classifyIntersectionTopology([
    arm(-1, 0), arm(1, 0), arm(0, -1), arm(0, 1),
  ]), 'four-way');
  assert.equal(classifyIntersectionTopology([
    arm(-1, 0), arm(1, 0), arm(-0.4, -1), arm(0.2, 1), arm(1, 1),
  ]), 'skewed-junction');
  assert.equal(classifyIntersectionTopology([
    arm(-1, 0, { divided: true }), arm(1, 0), arm(0, -1), arm(0, 1),
  ]), 'divided-crossing');
  assert.equal(classifyIntersectionTopology([arm(1, 0)], { roundabout: true }), 'roundabout');
});

function road(points, tags = {}) {
  const value = { highway: 'residential', tags: { context: 'urban', ...tags }, points };
  return { ...value, spec: classifyRoad(value, profile) };
}

test('network classifier combines split ways at shared nodes and retains bends', () => {
  const roads = [
    road([[10, 40], [40, 40]]),
    road([[40, 40], [70, 40]]),
    road([[40, 40], [40, 70]]),
    road([[80, 20], [100, 20], [100, 40]]),
  ];
  const nodes = buildIntersectionTopology(roads, profile);
  assert.equal(nodes.find((node) => node.x === 40 && node.y === 40)?.topology, 't-junction');
  assert.equal(nodes.find((node) => node.x === 100 && node.y === 20)?.topology, 'bend');
  assert.equal(nodes.find((node) => node.x === 10 && node.y === 40)?.topology, 'dead-end');
});

test('closed roundabout ways become one centred topology instead of many bends', () => {
  const ring = road([
    [40, 30], [50, 40], [40, 50], [30, 40], [40, 30],
  ], { junction: 'roundabout' });
  const nodes = buildIntersectionTopology([ring], profile);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].topology, 'roundabout');
  assert.deepEqual([nodes[0].x, nodes[0].y], [40, 40]);
  assert.ok(nodes[0].radius > 10);
});

test('intersection pass fills conflict area and clears stale curb and line artwork', () => {
  const canvas = new TileCanvas();
  const plan = createCurbPlan();
  canvas.set(50, 50, FLOOR, 'old_surface');
  canvas.set(50, 50, FLOOR_OVERLAY, 'old_line');
  canvas.set(50, 50, FLOOR_FURNITURE, 'old_curb');
  const intersection = {
    x: 50, y: 50, topology: 'four-way', radius: 4,
    arms: [arm(-1, 0, { roadClass: 'residential' }), arm(1, 0), arm(0, -1), arm(0, 1)],
  };

  const writes = renderIntersections(canvas, [intersection], plan, {
    inWorld: (x, y) => x >= 0 && y >= 0 && x < 100 && y < 100,
  });
  assert.ok(writes > 0);
  assert.equal(canvas.get(50, 50)[FLOOR], 'blends_street_01_86');
  assert.equal(canvas.get(50, 50)[FLOOR_OVERLAY], undefined);
  assert.equal(canvas.get(50, 50)[FLOOR_FURNITURE], undefined);
  assert.ok(plan.carriageway.has('50,50'));
  assert.ok(plan.openings.some((opening) => opening.kind === 'junction'));
  assert.ok(plan.openings.some((opening) => opening.kind === 'crossing'));
  assert.equal(plan.intersections.at(-1).topology, 'four-way');
});

test('roundabout pass preserves a planted central island and asphalt circulation', () => {
  const canvas = new TileCanvas();
  const plan = createCurbPlan();
  renderIntersections(canvas, [{
    x: 30, y: 30, topology: 'roundabout', radius: 8,
    arms: [arm(1, 0, { roadClass: 'residential' })],
  }], plan, { inWorld: () => true });

  assert.equal(canvas.get(30, 30)[FLOOR], 'blends_natural_01_16');
  assert.equal(canvas.get(36, 30)[FLOOR], 'blends_street_01_86');
  assert.equal(plan.carriageway.has('30,30'), false);
  assert.equal(plan.carriageway.has('36,30'), true);
});
