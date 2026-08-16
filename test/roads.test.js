/**
 * The road bands and the static-module invariant.
 *
 * These pin the two things that were wrong in the world the player was
 * actually walking around in:
 *
 *   1. the bands were point-sampled along the normal, so a road at any bearing
 *      but 0 or 90 degrees got a pavement with holes punched through it;
 *   2. every module overlapped every other one, and `WorldGenChunk` resolves an
 *      overlap by keeping the first module and discarding the rest.
 *
 * They run against `tools/simulate.js`, which is a transcription of the mod's
 * Lua. DEV_GUIDE §6.2 applies — an offline model is a hypothesis until the game
 * agrees — but a band with a hole in it is geometry, and geometry can be
 * settled here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { capsuleRows, forEachInBand, kerbFor, simplify } from '../tools/simulate.js';

/** Every square within `r` of the segment, as a set of "x,y". */
function band(x0, y0, x1, y1, r) {
  const seen = new Set();
  const dupes = [];
  forEachInBand({ pts: [[x0, y0], [x1, y1]] }, r, (x, y) => {
    const k = `${x},${y}`;
    if (seen.has(k)) dupes.push(k);
    seen.add(k);
  });
  return { seen, dupes };
}

/** The same set, by brute force over the bounding box. */
function bruteForce(x0, y0, x1, y1, r) {
  const out = new Set();
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  for (let y = Math.floor(Math.min(y0, y1) - r) - 2; y <= Math.ceil(Math.max(y0, y1) + r) + 2; y++) {
    for (let x = Math.floor(Math.min(x0, x1) - r) - 2; x <= Math.ceil(Math.max(x0, x1) + r) + 2; x++) {
      let t = len < 1e-9 ? 0 : ((x - x0) * dx + (y - y0) * dy) / (len * len);
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      if (Math.hypot(x0 + dx * t - x, y0 + dy * t - y) <= r) out.add(`${x},${y}`);
    }
  }
  return out;
}

test('a band is filled exactly, at every bearing', () => {
  // 0 and 90 degrees were always right; it is 22 and 45 that used to come out
  // dotted, and 45 is where the diagonal streets are.
  for (const deg of [0, 7, 22, 30, 45, 63, 90, 117, 180, 231, 300]) {
    for (const r of [1.5, 3, 5.5]) {
      const rad = (deg * Math.PI) / 180;
      const x0 = 1000.3;
      const y0 = 1000.7;
      const x1 = x0 + Math.cos(rad) * 40;
      const y1 = y0 + Math.sin(rad) * 40;

      const { seen } = band(x0, y0, x1, y1, r);
      const want = bruteForce(x0, y0, x1, y1, r);

      assert.deepEqual(
        [...want].filter((k) => !seen.has(k)),
        [],
        `holes in the band at ${deg} deg, radius ${r}`,
      );
      assert.deepEqual(
        [...seen].filter((k) => !want.has(k)),
        [],
        `squares outside the band at ${deg} deg, radius ${r}`,
      );
    }
  }
});

test('no square is emitted twice for one segment', () => {
  for (const deg of [13, 45, 77]) {
    const rad = (deg * Math.PI) / 180;
    const { dupes } = band(500, 500, 500 + Math.cos(rad) * 25, 500 + Math.sin(rad) * 25, 4);
    assert.equal(dupes.length, 0, `${dupes.length} squares emitted twice at ${deg} deg`);
  }
});

test('a diagonal band is as solid as an axis-aligned one', () => {
  // The old sampler produced roughly 1/sqrt(2) of the squares on a diagonal,
  // and the missing ones were the dashes. Compare area against length*width.
  const r = 4;
  const straight = band(100, 100, 140, 100, r).seen.size;
  const diagonal = band(100, 100, 100 + 40 / Math.SQRT2, 100 + 40 / Math.SQRT2, r).seen.size;
  const ratio = diagonal / straight;
  assert.ok(ratio > 0.85, `diagonal band is only ${(ratio * 100).toFixed(0)}% as dense as a straight one`);
});

test('consecutive segments leave no notch at the joint', () => {
  // Two segments meeting at a right angle. Painted separately with square ends
  // this leaves an r x r wedge of grass on the outside of every corner.
  const seen = new Set();
  forEachInBand({ pts: [[200, 200], [240, 200], [240, 240]] }, 3, (x, y) => seen.add(`${x},${y}`));
  const corner = bruteForce(240, 200, 240, 200, 3); // the disc at the joint
  for (const k of corner) assert.ok(seen.has(k), `notch at the corner: ${k} missing`);
});

test('capsuleRows covers each row once and only where the capsule reaches', () => {
  const rows = [];
  capsuleRows(10, 10, 30, 22, 4, (y, lo, hi) => rows.push([y, lo, hi]));
  const ys = rows.map((r) => r[0]);
  assert.deepEqual(ys, [...new Set(ys)].sort((a, b) => a - b), 'rows repeated or out of order');
  assert.ok(Math.min(...ys) >= 10 - 4 - 1 && Math.max(...ys) <= 22 + 4 + 1, 'rows outside the capsule');
});

test('kerb facing follows the direction the road lies in', () => {
  // Measured on 60 Muldraugh cells: _9 has road to its east, _11 to its west,
  // _8 to its south, _10 to its north. The vector passed in points from the
  // kerb square towards the road, and y increases southward.
  assert.equal(kerbFor(1, 0), 'street_curbs_01_9', 'road to the east');
  assert.equal(kerbFor(-1, 0), 'street_curbs_01_11', 'road to the west');
  assert.equal(kerbFor(0, -1), 'street_curbs_01_10', 'road to the north');
  assert.equal(kerbFor(0, 1), 'street_curbs_01_8', 'road to the south');
  // A near-diagonal resolves onto its dominant axis rather than falling through.
  assert.equal(kerbFor(0.8, 0.6), 'street_curbs_01_9');
  assert.equal(kerbFor(0.6, -0.8), 'street_curbs_01_10');
});

test('simplify keeps the shape and drops the filler', () => {
  const straight = [];
  for (let i = 0; i <= 20; i++) straight.push([i * 4, 100]);
  const out = simplify(straight, 2, 96);
  assert.ok(out.length < straight.length / 2, 'a straight run was not simplified');
  assert.deepEqual(out[0], straight[0]);
  assert.deepEqual(out[out.length - 1], straight[straight.length - 1]);

  const corner = [[0, 0], [50, 0], [50, 50]];
  assert.deepEqual(simplify(corner, 2, 96), corner, 'a real corner was flattened');
});
