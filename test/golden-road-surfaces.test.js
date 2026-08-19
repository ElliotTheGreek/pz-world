import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  GOLDEN_SCHEMA,
  INTERSECTION_TYPES,
  ROAD_CLASSES,
  baseTransformFixture,
  goldenRasterCases,
  rasterGoldenDocument,
  renderTransformFixture,
  terrainBoundaryGolden,
  topologyMask,
  transformedMask,
} from './fixtures/road-surface-cases.js';

const rasterGolden = JSON.parse(readFileSync(
  new URL('./goldens/road-surfaces.json', import.meta.url),
  'utf8',
));
const terrainGolden = JSON.parse(readFileSync(
  new URL('./goldens/terrain-boundaries.json', import.meta.url),
  'utf8',
));

const ids = goldenRasterCases().map(({ id }) => id);

function includesEvery(prefix, values) {
  const actual = ids.filter((id) => id.startsWith(`${prefix}/`));
  assert.deepEqual(actual, values.map((value) => `${prefix}/${value}`));
}

test('golden fixture manifest covers every required road and surface family', () => {
  includesEvery('class', ROAD_CLASSES);
  includesEvery('bearing', ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne']);
  includesEvery('bend', ['es', 'sw', 'wn', 'ne', 'diagonal']);
  includesEvery('intersection', INTERSECTION_TYPES);

  includesEvery('curb', [
    'cardinal-horizontal', 'cardinal-vertical', 'diagonal-nw-se', 'diagonal-ne-sw',
    'opening-crossing', 'opening-driveway',
  ]);
  includesEvery('sidewalk', [
    'straight-concrete', 'bend-corners-and-ends', 'diagonal-edge', 'one-sided-cut',
    'driveway-and-crossing-cuts', 'gravel-surface',
  ]);
  assert.ok(ids.includes('marking/highway-dashed-and-edge'));
  assert.ok(ids.includes('marking/rural-centre'));
  assert.ok(ids.includes('marking/explicit-none'));
  assert.ok(ids.includes('bridge/straight-with-approaches'));
  assert.equal(new Set(ids).size, ids.length, 'fixture ids must be unique');
});

/**
 * What changed, per case, as a histogram of tile substitutions.
 *
 * `assert.deepEqual` on the whole document is useless here: the raster is about
 * a megabyte of coordinates, and when a real change lands node's differ runs out
 * of heap building the diff string and reports `RangeError: Array buffer
 * allocation failed` — which says nothing at all about the road. This says
 * `blends_street_01_54 -> blends_street_01_86 ×244` instead, which is the shape
 * of the answer you actually need before deciding whether to re-bless.
 */
function describeRasterDrift(actual, expected) {
  const lines = [];
  const key = (entry) => `${entry[0]},${entry[1]}`;
  for (const id of new Set([...Object.keys(expected.cases), ...Object.keys(actual.cases)])) {
    const before = expected.cases[id];
    const after = actual.cases[id];
    if (!before) { lines.push(`${id}: not in the golden`); continue; }
    if (!after) { lines.push(`${id}: no longer rendered`); continue; }
    const was = new Map(before.map((entry) => [key(entry), entry[2]]));
    const now = new Map(after.map((entry) => [key(entry), entry[2]]));
    const changes = new Map();
    const bump = (what) => changes.set(what, (changes.get(what) ?? 0) + 1);
    for (const [at, layers] of was) {
      const current = now.get(at);
      if (!current) { bump('square no longer painted'); continue; }
      for (const layer of new Set([...Object.keys(layers), ...Object.keys(current)])) {
        if (layers[layer] !== current[layer]) {
          bump(`${layer}: ${layers[layer] ?? 'nothing'} -> ${current[layer] ?? 'nothing'}`);
        }
      }
    }
    for (const at of now.keys()) if (!was.has(at)) bump('square newly painted');
    if (!changes.size) continue;
    lines.push(`${id} (${before.length} -> ${after.length} squares)`);
    for (const [what, count] of [...changes].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${String(count).padStart(6)}  ${what}`);
    }
  }
  return lines.join('\n');
}

test('road and surface layers match the committed golden raster square-for-square', () => {
  const actual = rasterGoldenDocument();
  assert.equal(actual.schema, GOLDEN_SCHEMA);
  const drift = describeRasterDrift(actual, rasterGolden);
  assert.equal(drift, '',
    `the raster moved; re-bless with \`node tools/update-golden-road-surfaces.mjs\` only if every line below is intended:
${drift}`);
});

test('terrain noise is stable immediately across world and cell boundaries', () => {
  assert.deepEqual(terrainBoundaryGolden(), terrainGolden);
});

const transformKinds = [
  'road',
  ...INTERSECTION_TYPES.map((type) => `intersection/${type}`),
];
for (const kind of transformKinds) {
  for (const transform of ['rotate90', 'rotate180', 'rotate270', 'reflectX', 'reflectY']) {
    test(`${kind} topology is equivariant under ${transform}`, () => {
      const expected = transformedMask(baseTransformFixture(kind), transform);
      const actual = topologyMask(renderTransformFixture(kind, transform));
      assert.deepEqual(actual, expected);
    });
  }
}
