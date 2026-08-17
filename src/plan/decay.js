/**
 * Wear on the tarmac.
 *
 * A generated road is 1.9 million squares of one of four interchangeable asphalt tiles,
 * and however the tile is chosen the result is flat: the eye picks out the grid long
 * before it picks out the street. `baseTile` handles the broad shading with low-frequency
 * noise; this adds the patchy staining on top of it.
 *
 * What vanilla does, measured over 72,292 sampled road squares in Muldraugh: 36.5% carry
 * *something* extra, but almost all of that is edge work — grass blends (18,558), traffic
 * lines (6,137) and kerbs (2,218). Actual grime is rare:
 *
 *     overlay_grime_floor_01   389 of 72,292 road squares   0.54%
 *
 * So this is not reproducing a vanilla feature at a vanilla rate; it is a deliberate
 * addition, and `DECAY_RATE` is the dial. It is driven by the same kind of low-frequency
 * field as the ground texture so the staining pools in patches — a worn junction, a
 * stretch that has not been resurfaced — rather than speckling evenly over every road in
 * the city, which would be the same flatness in a different colour.
 *
 * The tiles are the ones the shipped maps actually use, in the proportions they use them.
 */

import { hashString } from '../lib/rng.js';

/** Share of road squares that take a stain at the centre of a worn patch. */
export const DECAY_RATE = 0.45;

/**
 * How much of the field counts as worn. Higher leaves more clean tarmac.
 * Together with `DECAY_RATE` this sets the overall coverage — about 7% of road.
 */
export const DECAY_THRESHOLD = 0.5;

/** Squares across a worn patch. Smaller than the ground texture: wear is more local. */
export const DECAY_SCALE = 55;

/**
 * Contrast on the wear field, for the same reason the stand field needs it.
 *
 * Summed octaves cluster hard around the midpoint: measured, `fbm(scale 55, 3 octaves)`
 * runs 0.433 at the 5th percentile to 0.564 at the 95th. A threshold of 0.58 against
 * that caught 1.9% of the field, and the strength ramp then thinned it to almost nothing
 * — the first build with this pass stained **347** squares out of 1.9 million road
 * squares, which is indistinguishable from the feature not existing.
 *
 * Stretching about the midpoint gives the field its full range back.
 */
export const DECAY_CONTRAST = 5;

const shape = (n) => {
  const v = (n - 0.5) * DECAY_CONTRAST + 0.5;
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

/**
 * Grime tiles, weighted as Muldraugh uses them. `_28` and `_29` dominate; `_0` and `_1`
 * are the lighter marks.
 */
export const GRIME = [
  { tile: 'overlay_grime_floor_01_28', weight: 1370 },
  { tile: 'overlay_grime_floor_01_29', weight: 1244 },
  { tile: 'overlay_grime_floor_01_1', weight: 558 },
  { tile: 'overlay_grime_floor_01_0', weight: 437 },
  { tile: 'overlay_grime_floor_01_30', weight: 48 },
  { tile: 'overlay_grime_floor_01_17', weight: 34 },
  { tile: 'overlay_grime_floor_01_19', weight: 26 },
  { tile: 'overlay_grime_floor_01_18', weight: 22 },
];

const TOTAL = GRIME.reduce((s, g) => s + g.weight, 0);

/**
 * The stain on a road square, if any.
 *
 * @param {number} x
 * @param {number} y
 * @param {import('../lib/noise.js').Noise} field
 * @param {string} seed
 * @returns {string|null}
 */
export function decayAt(x, y, field, seed = '') {
  if (!field) return null;
  const wear = shape(field.fbm(x, y, DECAY_SCALE, 3));
  if (wear < DECAY_THRESHOLD) return null;

  // Inside a worn patch, thin out towards its edge rather than stopping at a hard line.
  const strength = (wear - DECAY_THRESHOLD) / (1 - DECAY_THRESHOLD);
  const roll = hashString(`decay:${seed}:${x},${y}`) % 10000;
  if (roll >= Math.round(DECAY_RATE * strength * 10000)) return null;

  const pick = hashString(`grime:${seed}:${x},${y}`) % TOTAL;
  let acc = 0;
  for (const g of GRIME) {
    acc += g.weight;
    if (pick < acc) return g.tile;
  }
  return GRIME[0].tile;
}
