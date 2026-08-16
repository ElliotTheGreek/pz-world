/**
 * The geometry and planning layer.
 *
 * These are the parts with no external reference to check against — there is no
 * vanilla file that says what the right answer is — so they are tested against
 * constructed cases where the answer is known by hand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Projection, bboxAround, distanceM } from '../src/geo/project.js';
import {
  dominantBearing,
  gridAlignment,
  orientedBounds,
  convexHull,
  snapFootprint,
  foldToQuarter,
} from '../src/geo/orient.js';
import { walkSegment, isDiagonalRun, classifyRoad, loadRoadProfile } from '../src/plan/roads.js';
import { fillPolygon, polygonArea, groundPixelFor } from '../src/plan/zones.js';
import { SparseGrid, TileCanvas } from '../src/plan/grid.js';
import { classifyFromTags } from '../src/plan/buildings.js';
import { clipPolyline, intersectsBounds } from '../src/plan/index.js';
import { classifyBuilding } from '../src/prefab/classify.js';
import { makeRng, hashGeometry, streamFor } from '../src/lib/rng.js';
import { stripComments } from '../src/lib/jsonc.js';

test('projection round-trips a point', () => {
  const p = new Projection({ lat: 44.4759, lon: -73.2121, metresPerTile: 1 });
  const [x, y] = p.toTile(-73.2, 44.48);
  const [lon, lat] = p.fromTile(x, y);
  assert.ok(Math.abs(lon - -73.2) < 1e-6, `lon ${lon}`);
  assert.ok(Math.abs(lat - 44.48) < 1e-6, `lat ${lat}`);
});

test('north is negative y', () => {
  // Project Zomboid's y axis grows southward. Getting this backwards mirrors
  // the whole city, which looks plausible until you compare it with a map.
  const p = new Projection({ lat: 44, lon: -73 });
  const [, ySouth] = p.toTile(-73, 43.99);
  const [, yNorth] = p.toTile(-73, 44.01);
  assert.ok(yNorth < 0, 'a point to the north should have negative y');
  assert.ok(ySouth > 0, 'a point to the south should have positive y');
});

test('one square is one metre by default', () => {
  const p = new Projection({ lat: 44, lon: -73 });
  const [x] = p.toTile(-73 + 0.001, 44);
  const metres = distanceM(-73, 44, -73 + 0.001, 44);
  assert.ok(Math.abs(x - metres) < 0.5, `${x} squares vs ${metres} metres`);
});

test('a rotated projection puts a diagonal street on an axis', () => {
  const p = new Projection({ lat: 44, lon: -73, bearing: 45 });
  // A point 100 m north-east of the origin should land on an axis once the
  // world is rotated 45°.
  const [e, n] = [100, 100];
  const [lon, lat] = p.toLonLat(e, n);
  const [x, y] = p.toTile(lon, lat);
  assert.ok(Math.abs(x) < 1 || Math.abs(y) < 1, `expected an axis, got ${x}, ${y}`);
});

test('bboxAround is square in metres', () => {
  const b = bboxAround(44, -73, 1000);
  const height = distanceM(-73, b.south, -73, b.north);
  const width = distanceM(b.west, 44, b.east, 44);
  assert.ok(Math.abs(height - 2000) < 20, `height ${height}`);
  assert.ok(Math.abs(width - 2000) < 20, `width ${width}`);
});

test('dominant bearing finds a rotated street grid', () => {
  // A gridiron laid at 30°, with streets running both ways.
  const rad = (30 * Math.PI) / 180;
  const ways = [];
  for (let i = 0; i < 5; i++) {
    const off = i * 100;
    ways.push({
      points: [
        [off * -Math.sin(rad), off * Math.cos(rad)],
        [off * -Math.sin(rad) + 500 * Math.cos(rad), off * Math.cos(rad) + 500 * Math.sin(rad)],
      ],
    });
    ways.push({
      points: [
        [off * Math.cos(rad), off * Math.sin(rad)],
        [off * Math.cos(rad) - 500 * Math.sin(rad), off * Math.sin(rad) + 500 * Math.cos(rad)],
      ],
    });
  }
  const bearing = dominantBearing(ways);
  assert.ok(Math.abs(bearing - 30) < 2, `expected ~30°, got ${bearing}`);
  // And rotating by it should align the grid.
  assert.ok(gridAlignment(ways, bearing) > 0.95, 'rotation did not align the grid');
  assert.ok(gridAlignment(ways, 0) < 0.2, 'the grid should not already be aligned');
});

test('foldToQuarter keeps everything in [0,90)', () => {
  for (const d of [-450, -91, -1, 0, 45, 89.9, 90, 91, 271, 360]) {
    const f = foldToQuarter(d);
    assert.ok(f >= 0 && f < 90, `${d} folded to ${f}`);
  }
});

test('oriented bounds finds the tight box of a rotated rectangle', () => {
  const rad = (20 * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rect = [
    [0, 0],
    [20, 0],
    [20, 8],
    [0, 8],
  ].map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);

  const obb = orientedBounds(rect);
  const long = Math.max(obb.w, obb.h);
  const short = Math.min(obb.w, obb.h);
  assert.ok(Math.abs(long - 20) < 0.01, `long side ${long}`);
  assert.ok(Math.abs(short - 8) < 0.01, `short side ${short}`);
  assert.ok(Math.abs(foldToQuarter(obb.angle) - 20) < 0.01, `angle ${obb.angle}`);
});

test('convex hull ignores interior points', () => {
  const hull = convexHull([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [5, 5],
    [3, 7],
  ]);
  assert.equal(hull.length, 4);
});

test('snapping an axis-aligned footprint costs nothing', () => {
  const snap = snapFootprint([
    [0, 0],
    [12, 0],
    [12, 8],
    [0, 8],
    [0, 0],
  ]);
  assert.ok(Math.abs(snap.residualDeg) < 0.01, `residual ${snap.residualDeg}`);
  assert.ok(Math.abs(snap.w - 12) < 0.01);
  assert.ok(Math.abs(snap.h - 8) < 0.01);
  assert.ok(Math.abs(snap.cx - 6) < 0.01);
});

test('snapping reports the worst case as 45 degrees, never more', () => {
  for (let angle = 0; angle < 180; angle += 3) {
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rect = [
      [0, 0],
      [14, 0],
      [14, 9],
      [0, 9],
    ].map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
    const snap = snapFootprint(rect);
    assert.ok(
      Math.abs(snap.residualDeg) <= 45.001,
      `angle ${angle} gave residual ${snap.residualDeg}`,
    );
  }
});

test('segment walk is 8-connected with no diagonal gaps', () => {
  const squares = walkSegment(0, 0, 10, 7);
  // Every consecutive pair must be orthogonally adjacent — a road with a
  // diagonal gap is a road a survivor can walk through.
  for (let i = 1; i < squares.length; i++) {
    const [ax, ay] = squares[i - 1];
    const [bx, by] = squares[i];
    const step = Math.abs(ax - bx) + Math.abs(ay - by);
    assert.equal(step, 1, `gap between ${ax},${ay} and ${bx},${by}`);
  }
  assert.deepEqual(squares[0], [0, 0]);
  assert.deepEqual(squares[squares.length - 1], [10, 7]);
});

test('diagonal runs are detected only near 45 degrees', () => {
  const tol = 0.35;
  assert.ok(isDiagonalRun(10, 10, tol), 'exactly 45° is diagonal');
  assert.ok(isDiagonalRun(10, 8, tol), '39° is close enough');
  assert.ok(!isDiagonalRun(10, 0, tol), 'due east is not diagonal');
  assert.ok(!isDiagonalRun(10, 2, tol), '11° is not diagonal');
  assert.ok(!isDiagonalRun(0, 10, tol), 'due south is not diagonal');
});

test('road classification uses lane counts when OSM has them', () => {
  const profile = loadRoadProfile();
  const plain = classifyRoad({ highway: 'residential' }, profile);
  assert.equal(plain.cls, 'residential');
  const wide = classifyRoad({ highway: 'residential', lanes: 4 }, profile);
  assert.ok(wide.width > plain.width, 'four lanes should be wider than the default');
  assert.equal(classifyRoad({ highway: 'proposed' }, profile), null);
  assert.equal(classifyRoad({ highway: 'nonsense' }, profile), null);
});

test('polygon fill covers the interior and respects area', () => {
  const grid = new SparseGrid(0);
  const square = [
    [10, 10],
    [20, 10],
    [20, 20],
    [10, 20],
    [10, 10],
  ];
  const painted = fillPolygon(grid, square, 115);
  assert.ok(painted > 90 && painted <= 121, `painted ${painted}`);
  assert.equal(grid.get(15, 15), 115);
  assert.equal(grid.get(5, 15), 0, 'outside the polygon must be untouched');
  assert.equal(polygonArea(square), 100);
});

test('sparse grid allocates only the cells it is asked for', () => {
  const grid = new SparseGrid(96);
  assert.equal(grid.cellCount, 0);
  assert.equal(grid.get(100000, 100000), 96, 'an untouched square reads as the fill');
  grid.set(300, 300, 12);
  assert.equal(grid.cellCount, 1);
  assert.equal(grid.get(300, 300), 12);
  const [cell] = grid.list();
  assert.equal(cell.cx, 1);
  assert.equal(cell.cy, 1);
});

test('tile canvas keys round-trip including negatives', () => {
  const canvas = new TileCanvas();
  for (const [x, y] of [[0, 0], [-5, 12], [4000, -70000], [123456, 654321]]) {
    const k = TileCanvas.key(x, y);
    assert.deepEqual(TileCanvas.unkey(k), [x, y], `${x},${y}`);
  }
  canvas.set(-5, 12, 'Floor', 'blends_street_01_86');
  assert.equal(canvas.get(-5, 12).Floor, 'blends_street_01_86');
});

test('OSM tags pick the class that makes loot correct', () => {
  assert.equal(classifyFromTags({ amenity: 'hospital' }, 400), 'medical');
  assert.equal(classifyFromTags({ shop: 'supermarket' }, 400), 'grocery');
  assert.equal(classifyFromTags({ shop: 'jeweller' }, 100), 'retail');
  assert.equal(classifyFromTags({ amenity: 'police' }, 400), 'police');
  assert.equal(classifyFromTags({ building: 'house' }, 120), 'house');
  // A specific amenity must beat the generic building tag.
  assert.equal(classifyFromTags({ building: 'yes', amenity: 'hospital' }, 400), 'medical');
  // building=yes says nothing, so size decides.
  assert.equal(classifyFromTags({ building: 'yes' }, 20), 'shed');
});

test('room names classify a vanilla building', () => {
  assert.equal(classifyBuilding(['bedroom', 'bedroom', 'livingroom', 'kitchen'], 120).cls, 'house');
  assert.equal(classifyBuilding(['grocery', 'grocerystorage'], 600).cls, 'grocery');
  assert.equal(classifyBuilding(['policeoffice', 'prisoncells'], 800).cls, 'police');
  assert.equal(classifyBuilding(['hospitalroom', 'medical'], 900).cls, 'medical');
  // No evidence at all falls back to size.
  assert.equal(classifyBuilding([], 20).cls, 'shed');
});

test('the same geometry always draws the same choices', () => {
  const ring = [
    [-73.2, 44.47],
    [-73.199, 44.47],
    [-73.199, 44.471],
    [-73.2, 44.471],
  ];
  const a = hashGeometry(ring);
  const b = hashGeometry(ring.map(([x, y]) => [x, y]));
  assert.equal(a, b, 'geometry hash must not depend on array identity');

  const s1 = streamFor('seed', 'building', a);
  const s2 = streamFor('seed', 'building', a);
  assert.deepEqual([s1(), s1(), s1()], [s2(), s2(), s2()]);

  // A different seed must give a different world.
  const s3 = streamFor('other', 'building', a);
  assert.notEqual(s1(), s3());
});

test('weighted picks respect their weights', () => {
  const rng = makeRng(42);
  const items = [
    { n: 'a', weight: 1 },
    { n: 'b', weight: 9 },
  ];
  let b = 0;
  for (let i = 0; i < 2000; i++) if (rng.weighted(items).n === 'b') b++;
  assert.ok(b > 1600 && b < 1950, `b was chosen ${b} times in 2000`);
});

test('jsonc strips comments but not strings that look like them', () => {
  const parsed = JSON.parse(
    stripComments(`{
      // a line comment
      "url": "https://example.com/a//b", /* block */
      "re": "a/*b"
    }`),
  );
  assert.equal(parsed.url, 'https://example.com/a//b');
  assert.equal(parsed.re, 'a/*b');
});

/**
 * Overpass `out geom` returns a way's whole geometry whenever any part of it
 * touches the bounding box. One river that clips a corner once turned a 900 m
 * request into a 9,431 × 28,327 world of 4,256 mostly-empty cells, so the
 * clipping is worth a regression test of its own.
 */
test('geometry far outside the world is rejected', () => {
  const b = { minX: 0, minY: 0, maxX: 2000, maxY: 2000 };
  assert.ok(intersectsBounds([[100, 100], [200, 200]], b), 'inside');
  assert.ok(intersectsBounds([[-500, -500], [500, 500]], b), 'straddling');
  assert.ok(!intersectsBounds([[5000, 5000], [6000, 6000]], b), 'far away');
  assert.ok(!intersectsBounds([[-9000, 100], [-8000, 200]], b), 'far west');
});

test('a road crossing the world is clipped, not dropped', () => {
  const b = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };

  // An interstate running right across the map and far beyond it on both
  // sides must still be drawn across the map.
  const crossing = clipPolyline(
    [[-40000, 500], [-100, 500], [500, 500], [1100, 500], [40000, 500]],
    b,
  );
  assert.equal(crossing.length, 1, 'should survive as one run');
  assert.ok(crossing[0].length >= 3, 'and keep the vertices that reach the edges');
  assert.ok(crossing[0].some(([x]) => x >= 0 && x <= 1000), 'including the ones inside');

  // A way entirely elsewhere contributes nothing.
  assert.deepEqual(clipPolyline([[9000, 9000], [9500, 9500]], b), []);

  // A way that enters, leaves and re-enters becomes two runs.
  const twice = clipPolyline(
    [[500, 500], [500, 9000], [9000, 9000], [600, 9000], [600, 600]],
    b,
  );
  assert.equal(twice.length, 2, `expected two runs, got ${twice.length}`);
});

test('land cover tags map to biome greys BiomeMapConfig knows', () => {
  assert.equal(groundPixelFor({ natural: 'water' }), 0);
  assert.equal(groundPixelFor({ landuse: 'forest' }), 255);
  assert.equal(groundPixelFor({ landuse: 'residential' }), 115);
  assert.equal(groundPixelFor({ building: 'house' }), null);
});
