import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeCellUsage, serializeContextualUsage } from '../src/catalogue/contextual-usage.js';

function meta(name, family, tileset = name.replace(/_\d+$/, '')) {
  return { name, family, tileset, index: Number(name.match(/(\d+)$/)?.[1] ?? 0), declaredRoles: [], properties: {} };
}

function withoutTimestamp(document) {
  const { generatedAt, ...stable } = document;
  return stable;
}

test('contextual usage measures co-occurrence, facing, runs, surfaces, and road topology', () => {
  const catalogue = new Map([
    ['blends_street_0', meta('blends_street_0', 'road', 'blends_street')],
    ['street_curbs_0', meta('street_curbs_0', 'curb', 'street_curbs')],
    ['street_curbs_1', meta('street_curbs_1', 'curb', 'street_curbs')],
    ['street_curbs_2', meta('street_curbs_2', 'curb', 'street_curbs')],
    ['street_trafficlines_0', meta('street_trafficlines_0', 'marking', 'street_trafficlines')],
    ['blends_natural_0', meta('blends_natural_0', 'floor', 'blends_natural')],
  ]);
  const grid = new Map();
  const put = (x, y, ...tiles) => grid.set(`${x},${y}`, tiles);
  put(1, 0, 'blends_street_0');
  put(0, 1, 'blends_street_0');
  put(1, 1, 'blends_street_0', 'street_curbs_0', 'street_trafficlines_0');
  put(2, 1, 'blends_street_0', 'street_curbs_1');
  put(1, 2, 'blends_street_0');
  put(3, 1, 'blends_natural_0', 'street_curbs_2');

  const usages = analyzeCellUsage({
    map: 'Fixture', cell: '1_2', width: 4, height: 3,
    squares: (x, y) => grid.get(`${x},${y}`) ?? [],
  }, catalogue);
  const document = serializeContextualUsage(usages, { fixture: true }, 24);
  const center = document.tiles.find((tile) => tile.name === 'street_curbs_0');
  const east = document.tiles.find((tile) => tile.name === 'street_curbs_1');
  const transition = document.tiles.find((tile) => tile.name === 'street_curbs_2');
  const road = document.tiles.find((tile) => tile.name === 'blends_street_0');

  assert.deepEqual(center.cooccurrence.map((entry) => entry.value), ['blends_street_0', 'street_trafficlines_0']);
  assert.equal(center.surfaceContext[0].value, 'blends_street_0');
  assert.equal(center.orientationEvidence.inferred, 'east-west');
  assert.deepEqual(center.runPosition, [{ value: 'end', count: 1 }]);
  assert.deepEqual(east.runPosition, [{ value: 'middle-ew', count: 1 }]);
  assert.equal(transition.roadContext[0].value, 'road-edge');
  assert.equal(transition.neighboringSurfaces.west[0].value, 'blends_street_0');
  assert.ok(road.intersectionTopology.some((entry) => entry.value === 'cross'));
  assert.equal(center.evidencePriority, 'high');
  assert.equal(document.source, undefined);
  assert.equal(document.summary.placements, 10);
});

test('serialization is deterministic apart from generatedAt', () => {
  const catalogue = new Map([['mystery_sheet_4', meta('mystery_sheet_4', 'unknown', 'mystery_sheet')]]);
  const input = { map: 'Map', cell: '0_0', width: 1, height: 1, squares: () => ['mystery_sheet_4'] };
  const a = serializeContextualUsage(analyzeCellUsage(input, catalogue), { source: { scannedCells: 1 } });
  const b = serializeContextualUsage(analyzeCellUsage(input, catalogue), { source: { scannedCells: 1 } });
  assert.deepEqual(withoutTimestamp(a), withoutTimestamp(b));
  assert.equal(a.tiles[0].orientationEvidence.inferred, 'isolated');
  assert.equal(a.tiles[0].frequency.cellCount, 1);
});
