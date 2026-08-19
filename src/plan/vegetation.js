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
import { terrainFields } from './terrain-fields.js';
import { loadSemanticRegistry, resolveSemantic } from '../catalogue/semantic-registry.js';

/**
 * What vanilla actually plants on grass, and how often. The asset choices and measured
 * weights live in the semantic registry; this export remains for measurement/tests.
 */
const SEMANTIC_REGISTRY = loadSemanticRegistry();
export const VEGETATION = resolveSemantic(
  SEMANTIC_REGISTRY,
  'procedural.vegetation',
  { biome: 'wild' },
).variants.map(({ tile, weight }) => ({ tile, weight }));

/**
 * Share of grass squares that carry something.
 *
 * Vanilla's measured rates are 18.5% in town and 28.1% outside it. These are **half**
 * that, by request after seeing the first build in game: at the full rate a generated
 * world reads as denser than Muldraugh does, because vanilla's woodland is broken up by
 * hand-placed clearings, tracks and yards that nothing here reproduces — the measurement
 * is right and the result still looked too thick.
 *
 * `THINNING` is the dial; 1 restores the measured rates.
 */
export const THINNING = 0.5;
export const DENSITY_TOWN = 0.185 * THINNING;
export const DENSITY_WILD = 0.281 * THINNING;

/** Surfaces that may be planted. Tarmac and pavement are not among them. */
export const PLANTABLE = new Set(['grass', 'grassLight', 'meadow', 'dirtGrass']);

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
export const STAND_CONTRAST = 4;

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

/** Loose boulder objects validated for a ridgeline/outcrop placement context. */
export const BOULDERS = resolveSemantic(
  SEMANTIC_REGISTRY,
  'procedural.rock',
  { topology: 'ridge' },
).variants.map(({ tile }) => tile);

/** Build a deterministic weighted pool after installation compatibility filtering. */
export function createPlantPool(vegetation = VEGETATION, boulders = BOULDERS) {
  const cumulative = [];
  let totalWeight = 0;
  for (const variant of vegetation) {
    totalWeight += variant.weight;
    cumulative.push({ tile: variant.tile, upTo: totalWeight });
  }
  return { cumulative, totalWeight, boulders: [...boulders] };
}

const isTree = ({ tile }) => tile.startsWith('vegetation_trees_') || tile.startsWith('jumbo_tree_');
const isLowFoliage = ({ tile }) => tile.startsWith('vegetation_groundcover_') || tile.startsWith('vegetation_foliage_');

/**
 * Contextual pools retain the measured per-asset weights while enforcing semantics.
 * Parks and managed lots use low foliage plus a thinned share of trees; wilderness uses
 * the complete observed distribution. Farmland deliberately has no pool: future crop
 * rows own those squares, so generic woodland must not pre-empt them.
 */
export const PLANT_POOLS = {
  wild: createPlantPool(VEGETATION, BOULDERS),
  town: createPlantPool(VEGETATION.filter((variant) => !variant.tile.startsWith('vegetation_farm_')), []),
  managed: createPlantPool([
    ...VEGETATION.filter(isLowFoliage),
    ...VEGETATION.filter(isTree).map((variant) => ({ ...variant, weight: Math.max(1, Math.round(variant.weight * 0.08)) })),
  ], []),
};

const DEFAULT_POOL = PLANT_POOLS.wild;

/**
 * The two noise fields a world is planted from.
 *
 * Built once per build and handed to `plantAt`, because a `Noise` carries a 512-byte
 * permutation table and this is called 30 million times.
 */
export function vegetationFields(seed = '', terrain = terrainFields(seed)) {
  return {
    stands: terrain.view('vegetation'),
    outcrops: new Noise(`terrain:outcrops:${seed}`),
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
export function plantAt(x, y, density, seed = '', fields = null, pool = DEFAULT_POOL) {
  const f = fields ?? vegetationFields(seed);

  // Rock first: an outcrop wins the square it is on. Crests of the ridged field only,
  // so boulders run in lines the way real exposed rock does.
  if (f.outcrops.ridged(x, y, OUTCROP_SCALE) > RIDGE_THRESHOLD) {
    const rockRoll = hashString(`rock:${seed}:${x},${y}`) % 100000;
    if (rockRoll < Math.round(ROCK_RATE * 100000) && pool.boulders.length) {
      return pool.boulders[
        hashString(`rockpick:${seed}:${x},${y}`) % pool.boulders.length
      ];
    }
  }

  const local = density * 2 * shape(f.stands.fbm(x, y, STAND_SCALE, 3));

  // Two independent draws: whether to plant, and what. Reusing one hash for both
  // correlates the species with the gaps and lays the wood out in visible stripes.
  const roll = hashString(`veg:${seed}:${x},${y}`) % 10000;
  if (roll >= Math.round(local * 10000) || !pool.totalWeight) return null;

  const pick = hashString(`plant:${seed}:${x},${y}`) % pool.totalWeight;
  for (const entry of pool.cumulative) {
    if (pick < entry.upTo) return entry.tile;
  }
  return pool.cumulative[pool.cumulative.length - 1].tile;
}
