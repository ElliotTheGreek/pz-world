/**
 * Trees, shrubs and groundcover, as tiles.
 *
 * This exists because of a wrong assumption that survived three builds: that vegetation
 * on authored ground comes from the biome map, the way it does for the countryside the
 * runtime generator makes. It does not.
 *
 * `WorldGenChunk.genMapSquare` really does read the biome entry for an authored square
 * and really does call `getMapBiome` and `doPending` with it — but a square that already
 * carries an authored floor is not replanted. In the shipped maps the vegetation is
 * simply *in the cell*. Measured over Muldraugh, sampling every third square of 500
 * cells:
 *
 *     grass squares in cells with rooms       18.5% carry a vegetation tile
 *     grass squares in cells with no rooms    28.1%
 *
 * and the recipe is as plain as it could be — one vegetation tile laid on top of the
 * grass tile, nothing else:
 *
 *     508,325   blends_natural_01_16 | vegetation_trees_01_8
 *     506,267   blends_natural_01_23 | vegetation_trees_01_11
 *      53,866   blends_natural_01_23 | jumbo_tree_01_0
 *
 * So a generated world grows nothing until it writes those tiles itself, which is what
 * this does.
 */

import { hashString } from '../lib/rng.js';
import { Noise } from '../lib/noise.js';

/**
 * What vanilla actually plants on grass, and how often.
 *
 * Counts are from the same 500-cell sample. The four `vegetation_trees_01` tiles are
 * within 2% of each other and together with `jumbo_tree_01_0` account for 82% of
 * everything planted; the rest is undergrowth.
 */
export const VEGETATION = [
  { tile: 'vegetation_trees_01_8', weight: 143335 },
  { tile: 'vegetation_trees_01_9', weight: 142768 },
  { tile: 'vegetation_trees_01_10', weight: 140707 },
  { tile: 'vegetation_trees_01_11', weight: 140489 },
  { tile: 'jumbo_tree_01_0', weight: 126123 },
  { tile: 'vegetation_groundcover_01_19', weight: 7562 },
  { tile: 'vegetation_groundcover_01_23', weight: 7404 },
  { tile: 'vegetation_groundcover_01_18', weight: 7360 },
  { tile: 'vegetation_groundcover_01_21', weight: 7282 },
  { tile: 'vegetation_groundcover_01_22', weight: 6855 },
  { tile: 'vegetation_foliage_01_10', weight: 6825 },
  { tile: 'vegetation_foliage_01_9', weight: 6761 },
  { tile: 'vegetation_foliage_01_14', weight: 6733 },
  { tile: 'vegetation_foliage_01_13', weight: 6698 },
  { tile: 'vegetation_foliage_01_12', weight: 6682 },
  { tile: 'vegetation_foliage_01_8', weight: 6628 },
  { tile: 'vegetation_foliage_01_11', weight: 6567 },
  { tile: 'vegetation_farm_01_38', weight: 5514 },
  { tile: 'vegetation_farm_01_36', weight: 5375 },
  { tile: 'vegetation_farm_01_33', weight: 5284 },
  { tile: 'vegetation_farm_01_44', weight: 5071 },
  { tile: 'vegetation_farm_01_43', weight: 5058 },
  { tile: 'vegetation_farm_01_42', weight: 5024 },
  { tile: 'vegetation_farm_01_32', weight: 4964 },
];

/** Measured share of grass squares that carry something. */
export const DENSITY_TOWN = 0.185;
export const DENSITY_WILD = 0.281;

/** Surfaces that may be planted. Tarmac and pavement are not among them. */
export const PLANTABLE = new Set(['grass', 'grassLight', 'meadow']);

/**
 * How big a stand of trees is, in squares, and how big an outcrop is.
 *
 * Scattering at a flat probability gives an even grey fuzz of trees with no woods and no
 * clearings in it — statistically correct and visually nothing. The density is modulated
 * by fBm instead, so the same *average* number of trees arranges itself into stands.
 * 90 squares is a wood you can walk around in a minute or so.
 */
export const STAND_SCALE = 90;
export const OUTCROP_SCALE = 45;

/**
 * How hard the contrast is pushed on the stand field.
 *
 * Summing octaves narrows the distribution — the central limit theorem applies to fBm
 * like anything else — so raw fBm sits in a band around 0.5 and modulating by it produced
 * 0.246 to 0.320 across a whole map: statistically varied, visually uniform. Stretching
 * about the midpoint and clipping gives genuine clearings and genuine thickets.
 *
 * The clip is symmetric, so the mean stays at 0.5 and the total number of trees is still
 * the measured one. `test/emit.test.js` asserts both halves of that.
 */
export const STAND_CONTRAST = 3;

const shape = (n) => {
  const v = (n - 0.5) * STAND_CONTRAST + 0.5;
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

/**
 * Boulders, and the one number here that is not vanilla's.
 *
 * Muldraugh's authored cells carry a boulder on **0.005%** of their grass squares — 238
 * in 4.5 million. That is not a scatter, it is a handful of hand-placed props, and
 * reproducing it faithfully would mean no visible rocks at all. Project Zomboid's actual
 * rocks come from the foraging and ore system, which the biome map drives.
 *
 * So this is a decision rather than a measurement: boulders appear on the crests of a
 * ridged-noise field, at a rate that makes an outcrop something you come across rather
 * than something you never see. `ROCK_RATE` is the dial.
 */
export const ROCK_RATE = 0.006;
export const RIDGE_THRESHOLD = 0.72;

/** Boulder tiles, weighted as the shipped maps use them. */
export const BOULDERS = [
  'boulders_44', 'boulders_47', 'boulders_54', 'boulders_41', 'boulders_46',
  'boulders_42', 'boulders_48', 'boulders_52', 'boulders_43', 'boulders_45',
  'boulders_40', 'boulders_9',
];

const TOTAL_WEIGHT = VEGETATION.reduce((s, v) => s + v.weight, 0);

/** Build a cumulative table once, so choosing is a binary search rather than a scan. */
function cumulative() {
  const out = [];
  let acc = 0;
  for (const v of VEGETATION) {
    acc += v.weight;
    out.push({ tile: v.tile, upTo: acc });
  }
  return out;
}
const CUMULATIVE = cumulative();

/**
 * The two noise fields a world is planted from.
 *
 * Built once per build and handed to `plantAt`, because a `Noise` carries a 512-byte
 * permutation table and this is called 30 million times.
 */
export function vegetationFields(seed = '') {
  return {
    stands: new Noise(`trees:${seed}`),
    outcrops: new Noise(`rocks:${seed}`),
  };
}

/**
 * Which plant or boulder, if any, stands on this square.
 *
 * The average density is vanilla's; the *arrangement* is noise. `2 * fbm` has a mean of
 * about 1, so multiplying the measured density by it redistributes trees into stands and
 * clearings without changing how many there are — which matters, because the 18.5% and
 * 28.1% are the only things here anchored to the shipped maps.
 *
 * Deterministic on position and seed: the same coordinates give the same wood every
 * time, so a rebuild of the same city is the same city.
 *
 * @param {number} x world square
 * @param {number} y world square
 * @param {number} density mean share of squares to plant, 0..1
 * @param {string} seed
 * @param {{stands: Noise, outcrops: Noise}} fields from {@link vegetationFields}
 * @returns {string|null} a tile name, or null for bare grass
 */
export function plantAt(x, y, density, seed = '', fields = null) {
  const f = fields ?? vegetationFields(seed);

  // Rock first: an outcrop wins the square it is on. Crests of the ridged field only,
  // so boulders run in lines the way real exposed rock does.
  if (f.outcrops.ridged(x, y, OUTCROP_SCALE) > RIDGE_THRESHOLD) {
    const rockRoll = hashString(`rock:${seed}:${x},${y}`) % 100000;
    if (rockRoll < Math.round(ROCK_RATE * 100000)) {
      return BOULDERS[hashString(`rockpick:${seed}:${x},${y}`) % BOULDERS.length];
    }
  }

  const local = density * 2 * shape(f.stands.fbm(x, y, STAND_SCALE, 3));

  // Two independent draws: whether to plant, and what. Reusing one hash for both
  // correlates the species with the gaps and lays the wood out in visible stripes.
  const roll = hashString(`veg:${seed}:${x},${y}`) % 10000;
  if (roll >= Math.round(local * 10000)) return null;

  const pick = hashString(`plant:${seed}:${x},${y}`) % TOTAL_WEIGHT;
  for (const entry of CUMULATIVE) {
    if (pick < entry.upTo) return entry.tile;
  }
  return CUMULATIVE[CUMULATIVE.length - 1].tile;
}
