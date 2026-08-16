/**
 * Ground blending.
 *
 * Two things are being protected here.
 *
 * The first is the **catalogue merge**. `tiledefs.js` used to overwrite a tile when a
 * later file re-declared it, and `tiledefinitions_noiseworks.patch.tiles.txt` re-declares
 * most of the blend sheet carrying only `FootstepMaterial`. That erased `FloorMaterial`
 * and every `FloorAttachment*`, which is the entire input to this module — so the blend
 * table came out empty, silently, with no error anywhere. If that regresses, the first
 * test here fails rather than the world quietly going back to square edges.
 *
 * The second is the **table itself**, asserted against what 407 Muldraugh cells actually
 * do rather than against what looks reasonable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTileCatalogue } from '../src/formats/tiledefs.js';
import { findInstall } from '../src/lib/pzinstall.js';
import { loadBlendSets, baseTile, blendOverlays, PRECEDENCE } from '../src/plan/blends.js';

let cat = null;
try {
  cat = loadTileCatalogue(findInstall());
} catch {
  cat = null;
}
const sets = cat ? loadBlendSets(cat) : null;
const skip = cat ? false : 'no Project Zomboid install found';

test('a patch file adds properties instead of replacing the tile', { skip }, () => {
  // blends_natural_01_21 is declared once with its material and facing, and again in the
  // noiseworks patch with only FootstepMaterial. Both must survive.
  const t = cat.get('blends_natural_01_21');
  assert.ok(t, 'blends_natural_01_21 is missing from the catalogue');
  assert.equal(t.props.FloorMaterial, 'Grass_Dark', 'the patch file erased FloorMaterial');
  assert.equal(t.props.FootstepMaterial, 'Grass', 'the patch file was not applied');
  assert.ok('diamondFloor' in t.props, 'the patch file erased the base-tile marker');

  const edge = cat.get('blends_natural_01_24');
  assert.ok('FloorAttachmentN' in edge.props, 'the patch file erased the facing');
  assert.ok('IsFloorAttached' in edge.props, 'the patch file erased the overlay marker');
});

test('every blend surface derives a complete set', { skip }, () => {
  // The materials worldgen itself names in media/lua/server/WorldGen/features/ground/.
  for (const material of ['Sand', 'Grass_Dark', 'Grass_Medium', 'Grass_Light', 'Dirt', 'Dirt_Grass', 'Water', 'Road_06']) {
    const set = sets.get(material);
    assert.ok(set, `no blend set for ${material}`);
    assert.ok(set.variants.length >= 2, `${material} has ${set.variants.length} base variants`);
    for (const d of ['N', 'E', 'S', 'W']) {
      assert.ok(set.edge[d].length >= 1, `${material} has no ${d} edge`);
    }
    for (const c of ['NE', 'SE', 'SW', 'NW']) {
      assert.equal(typeof set.corner[c], 'number', `${material} has no ${c} corner`);
    }
  }
});

test('the block layout is the one measured on Muldraugh', { skip }, () => {
  const g = sets.get('Grass_Dark');
  assert.equal(g.sheet, 'blends_natural_01');
  assert.equal(g.base, 16);
  assert.deepEqual(g.variants, [0, 5, 6, 7]);
  assert.deepEqual(g.corner, { NW: 1, SE: 2, SW: 3, NE: 4 });
  assert.deepEqual(g.edge, { N: [8, 12], W: [9, 13], E: [10, 14], S: [11, 15] });

  // The main asphalt, and the block the old solid-tile painter was already using.
  const r = sets.get('Road_06');
  assert.equal(r.sheet, 'blends_street_01');
  assert.equal(r.base, 80);
  assert.ok(r.variants.includes(6), 'blends_street_01_86 should be a Road_06 base variant');
  // The street sheet has no second edge variant.
  assert.deepEqual(r.edge, { N: [8], W: [9], E: [10], S: [11] });
});

test('the malformed and contradictory blocks are excluded', { skip }, () => {
  // blends_natural_01 112-127 is declared Clay but is sixteen edges with no base.
  const clay = sets.get('Clay');
  assert.equal(clay.base, 96, 'Clay should resolve to the well-formed block, not 112');

  // blends_street_01 8-11 claim Road_01 but measure as Road_07 edges.
  const road1 = sets.get('Road_01');
  for (const d of ['N', 'E', 'S', 'W']) {
    assert.equal(road1.edge[d].length, 0, `Road_01 ${d} edge should be suppressed`);
  }
});

test('a patch of road in grass gets corners and edges, and the grass gets nothing', { skip }, () => {
  const road = new Set();
  for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) road.add(`${x},${y}`);
  const materialAt = (x, y) => (road.has(`${x},${y}`) ? 'Road_06' : 'Grass_Dark');
  const at = (x, y) => blendOverlays(sets, materialAt, x, y);

  const G = sets.get('Grass_Dark').base;
  // Corners of the patch: two cardinals of grass each, so one inner-corner tile.
  assert.deepEqual(at(2, 2), [`blends_natural_01_${G + 1}`], 'NW corner');
  assert.deepEqual(at(4, 2), [`blends_natural_01_${G + 4}`], 'NE corner');
  assert.deepEqual(at(2, 4), [`blends_natural_01_${G + 3}`], 'SW corner');
  assert.deepEqual(at(4, 4), [`blends_natural_01_${G + 2}`], 'SE corner');

  // Straight edges: one cardinal, either variant of that direction.
  const oneOf = (got, offsets, label) => {
    assert.equal(got.length, 1, `${label}: expected one overlay, got ${got.length}`);
    assert.ok(offsets.some((o) => got[0] === `blends_natural_01_${G + o}`), `${label}: got ${got[0]}`);
  };
  oneOf(at(3, 2), [8, 12], 'N edge');
  oneOf(at(2, 3), [9, 13], 'W edge');
  oneOf(at(4, 3), [10, 14], 'E edge');
  oneOf(at(3, 4), [11, 15], 'S edge');

  // The middle of the road, and every grass square, are untouched.
  assert.deepEqual(at(3, 3), [], 'the interior should not blend');
  for (const [x, y] of [[1, 1], [3, 1], [1, 3], [5, 5], [3, 5]]) {
    assert.deepEqual(at(x, y), [], `grass at ${x},${y} should not carry a road overlay`);
  }
});

test('a diagonal-only neighbour is never blended', { skip }, () => {
  // Measured at 100% over ~30,000 samples per diagonal: there is no outer-corner tile.
  const materialAt = (x, y) => (x === 1 && y === 1 ? 'Grass_Dark' : 'Road_06');
  assert.deepEqual(blendOverlays(sets, materialAt, 2, 2), [], 'NW-only diagonal');

  // ...and a diagonal is ignored entirely once a cardinal is set: S and S+SE and S+SW
  // all give the same single S edge.
  const G = sets.get('Grass_Dark').base;
  const south = (extra) => {
    const grass = new Set(['2,3', ...extra]);
    return blendOverlays(sets, (x, y) => (grass.has(`${x},${y}`) ? 'Grass_Dark' : 'Road_06'), 2, 2);
  };
  const plain = south([]);
  assert.equal(plain.length, 1);
  assert.deepEqual(south(['3,3']), plain, 'SE should not change the S edge');
  assert.deepEqual(south(['1,3']), plain, 'SW should not change the S edge');
  assert.ok([11, 15].some((o) => plain[0] === `blends_natural_01_${G + o}`));
});

test('opposite and three-sided contacts lay one tile per exposed side', { skip }, () => {
  const G = sets.get('Grass_Dark').base;
  const run = (grass) =>
    blendOverlays(sets, (x, y) => (new Set(grass).has(`${x},${y}`) ? 'Grass_Dark' : 'Road_06'), 2, 2)
      .map((t) => Number(t.slice('blends_natural_01_'.length)) - G)
      .sort((a, b) => a - b);

  // N and S, no corner possible: two straight edges.
  const ns = run(['2,1', '2,3']);
  assert.equal(ns.length, 2, `N+S gave ${ns}`);
  assert.ok(ns.every((o) => [8, 11, 12, 15].includes(o)), `N+S gave ${ns}`);

  // N, E and W: the two corners cover all three sides, so no straight edge is added.
  assert.deepEqual(run(['2,1', '3,2', '1,2']), [1, 4], 'N+E+W should be the two corners');

  // All four sides: four corners and nothing else.
  assert.deepEqual(run(['2,1', '3,2', '2,3', '1,2']), [1, 2, 3, 4], 'all four sides');
});

test('the overlay goes on the lower-precedence square, never the reverse', { skip }, () => {
  assert.ok(PRECEDENCE.Grass_Dark > PRECEDENCE.Road_06);
  assert.ok(PRECEDENCE.Water > PRECEDENCE.Grass_Dark);
  assert.ok(PRECEDENCE.Grass_Dark > PRECEDENCE.Grass_Medium);
  assert.ok(PRECEDENCE.Dirt > PRECEDENCE.Road_06, 'every natural surface outranks asphalt');

  const materialAt = (x, y) => (y <= 1 ? 'Grass_Dark' : 'Road_06');
  assert.equal(blendOverlays(sets, materialAt, 2, 2).length, 1, 'road should take the grass overlay');
  assert.deepEqual(blendOverlays(sets, materialAt, 2, 1), [], 'grass should take nothing');
});

test('base tiles and edge variants are deterministic', { skip }, () => {
  const g = sets.get('Grass_Dark');
  for (let i = 0; i < 20; i++) {
    assert.equal(baseTile(g, 17, 42), baseTile(g, 17, 42));
  }
  const chosen = new Set();
  for (let x = 0; x < 200; x++) chosen.add(baseTile(g, x, 0));
  assert.ok(chosen.size >= 3, `expected the variants to be used, saw ${chosen.size}`);
  for (const t of chosen) {
    assert.ok(g.variants.includes(Number(t.slice('blends_natural_01_'.length)) - g.base));
  }
});
