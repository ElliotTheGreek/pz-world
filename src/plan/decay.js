/**
 * Road wear: the material patches first, the grime overlay second.
 *
 * ## What vanilla actually does, measured
 *
 * Sampling every road square at level 0 across the sixteen busiest Muldraugh
 * cells, the worn look of a vanilla street is **the material changing**, not an
 * overlay. *Which* squares are sampled decides the answer, and the first attempt
 * got it wrong: taking every square on the street sheet mixes the carriageway in
 * with driveways, forecourts and parking aprons, and those are a different
 * material entirely. Walking three squares inward from each of 67,254 kerb
 * squares separates them:
 *
 *     inside the kerbs          no kerb or line within 3 squares
 *     Road_06  68.76%           Road_04  49.39%
 *     Road_07  28.64%           Road_07  42.07%
 *     Road_04   2.38%           Road_06   8.02%
 *
 * Road_04 is the pale tan of a driveway, and the undifferentiated 19.95% figure
 * put it on a fifth of every carriageway in the world. A whole city's tarmac came
 * out mottled tan and grey, which is not what a road looks like from above.
 *
 *     material run along a row: mean 8.40, median 4, p90 15
 *     variant run:              mean 1.29, median 1, p90 2
 *
 * On top of that sits one overlay family, on about a tenth of road squares:
 *
 *     overlay_grime_floor_01   38,678   10.70% of road squares
 *     d_streetcracks_*              0    none at all
 *     blends_streetoverlays_01    805    0.22%
 *
 * So the patchwork of good and bad tarmac a player sees is three asphalt
 * materials laid in ten-square patches with blend edges feathering between them,
 * plus a light dusting of grime. This module owns both halves. `d_streetcracks`
 * is real Build 42 artwork and is kept, but gated to roads OSM or their class say
 * are actually failing, rather than sprinkled over a whole city that vanilla
 * leaves clean.
 */

import { hashString } from '../lib/rng.js';
import { FIELD_SIGMA, fieldPercentile } from './terrain-fields.js';
import {
  loadSemanticRegistry,
  resolveSemantic,
  selectSemanticVariant,
} from '../catalogue/semantic-registry.js';

export const WEAR_EFFECTS = Object.freeze(['grime', 'crack', 'patch', 'faded-edge', 'damaged']);

/** Measured shares of the three asphalt materials on a vanilla town road. */
export const ROAD_MATERIALS = Object.freeze([
  ['road', 0.69],        // Road_06, the sound surface
  ['roadWorn', 0.29],    // Road_07, greyed and polished
  ['roadPatched', 0.02], // Road_04, the pale patch of a bad repair
]);

const CONDITION = Object.freeze({
  excellent: -0.24,
  good: -0.13,
  average: 0,
  worn: 0.13,
  poor: 0.25,
  damaged: 0.38,
});

/**
 * How much older than an ordinary street each class reads.
 *
 * Zero is `residential`, not `secondary`, because a residential street is most
 * of a town and the measured shares above are a whole town's. Centring anywhere
 * else ages the entire city by the offset.
 */
const CLASS_AGE = Object.freeze({
  motorway: -0.18,
  trunk: -0.15,
  primary: -0.11,
  secondary: -0.08,
  residential: 0,
  service: 0.08,
  cycleway: -0.06,
  track: 0.12,
  footway: 0.02,
});

/** Conditions bad enough for cracked and broken artwork rather than grime. */
const BROKEN_CONDITIONS = new Set(['worn', 'poor', 'damaged']);
const BROKEN_CLASSES = new Set(['service', 'track', 'footway']);

/**
 * The junction/edge contribution of a typical square, subtracted so those terms
 * move a road relative to its neighbours rather than ageing every road at once.
 */
const NEUTRAL_USE = 0.03;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function sample(fields, name, x, y, fallback = 0.5) {
  // TerrainFields.at accepts (name, x, y); the legacy Noise.at accepts only (x, y).
  // Treating both as the named API passes a string as Noise's x coordinate and turns
  // every signal into NaN, silently disabling wear for older callers.
  if (typeof fields?.at === 'function' && fields.at.length >= 3) return fields.at(name, x, y);
  if (typeof fields?.fbm === 'function') return fields.fbm(x, y);
  return fallback;
}

/** A field's value as its rank in its own distribution, whatever kind of field it is. */
function rank(fields, name, x, y) {
  if (typeof fields?.percentile === 'function') return fields.percentile(name, x, y);
  return fieldPercentile(sample(fields, name, x, y), FIELD_SIGMA[name] ?? 0.03);
}

/**
 * How hard this square of road has been used, 0..1 and roughly uniform.
 *
 * Exported so planners and tests can inspect behaviour without depending on a
 * particular installed tile catalogue.
 */
export function roadStress(x, y, fields, context = {}) {
  // One coherent field, taken as its rank so the result is uniform on 0..1 and
  // the measured material shares can be read straight off it as thresholds.
  // Mixing two ranks would narrow the distribution back toward 0.5 and put half
  // the world in whichever band happened to straddle the middle.
  const base = rank(fields, 'wear', x, y);
  const traffic = clamp01(context.traffic ?? 0.35);
  const edge = clamp01(context.edge ?? 0);
  const junctionDistance = Number.isFinite(context.junctionDistance) ? context.junctionDistance : 254;
  // Braking and turning happen at junctions, and the outside of a lane fails
  // before its middle does. `NEUTRAL_USE` re-centres the pair so an ordinary
  // stretch of ordinary street lands on the measured shares rather than above
  // them.
  const junction = Math.exp(-junctionDistance / 12);
  const use = junction * traffic * 0.14 + edge * 0.06 - NEUTRAL_USE;
  const condition = CONDITION[context.condition] ?? 0;
  const classAge = CLASS_AGE[context.roadClass] ?? 0;

  return clamp01(base + use + condition + classAge);
}

/**
 * Which asphalt a carriageway square is made of.
 *
 * The three materials come down in patches because `roadStress` is built from
 * coherent fields; the measured shares decide where the thresholds sit. A
 * motorway skews sound and a service alley skews resurfaced, which is `CLASS_AGE`
 * doing its work.
 */
export function roadMaterialAt(x, y, fields, context = {}) {
  if (!fields) return 'road';
  const stress = roadStress(x, y, fields, context);
  let cumulative = 0;
  for (const [material, share] of ROAD_MATERIALS) {
    cumulative += share;
    if (stress <= cumulative) return material;
  }
  return ROAD_MATERIALS[ROAD_MATERIALS.length - 1][0];
}

/**
 * Continuous wear signals, retained for planners and tests.
 *
 * `grime` is the ordinary case and is calibrated against vanilla's 10.7%. The
 * broken-surface signals stay at zero unless the road is one OSM or its class say
 * is actually failing, which is why a whole generated city no longer arrives
 * cracked when Muldraugh has no cracks in it at all.
 */
export function roadWearSignals(x, y, fields, context = {}) {
  const stress = roadStress(x, y, fields, context);
  const moisture = rank(fields, 'moisture', x, y);
  const rough = rank(fields, 'dirt', x, y);
  const edge = clamp01(context.edge ?? 0);
  const gravel = context.surface === 'gravel';
  const broken = BROKEN_CONDITIONS.has(context.condition) || BROKEN_CLASSES.has(context.roadClass);

  // Grime pools in the upper part of the stress field and in damp ground. The
  // offset puts its mean rate near a tenth, which is what Muldraugh measures.
  const grime = clamp01(stress * 0.74 + moisture * 0.22 - 0.645);
  if (!broken) {
    return { stress, grime, crack: 0, patch: 0, 'faded-edge': 0, damaged: 0 };
  }
  return {
    stress,
    grime,
    crack: gravel ? 0 : clamp01(stress * 0.72 + rough * 0.18 - 0.70),
    patch: gravel ? 0 : clamp01(stress * 0.70 - edge * 0.10 - 0.72),
    'faded-edge': gravel ? 0 : clamp01(stress * 0.60 + edge * 0.34 - 0.74),
    damaged: clamp01(stress * 0.80 + rough * 0.16 - 0.88),
  };
}

/** Select no more than one compatible overlay for a road square. */
export function roadWearAt(
  x,
  y,
  fields,
  context = {},
  seed = '',
  registry = loadSemanticRegistry(),
) {
  if (!fields) return null;
  const surface = context.surface ?? 'road';
  const signals = roadWearSignals(x, y, fields, { ...context, surface });

  // Severe effects take visual precedence. Effect-specific coherent scores prevent all
  // kinds from sharing exactly the same boundary while retaining the same broad patch.
  const candidates = WEAR_EFFECTS
    .map((effect) => ({ effect, strength: signals[effect] }))
    .filter(({ strength }) => strength > 0)
    .sort((a, b) => b.strength - a.strength || WEAR_EFFECTS.indexOf(a.effect) - WEAR_EFFECTS.indexOf(b.effect));

  for (const candidate of candidates) {
    // Feather only within an existing coherent patch. Adjacent high-strength squares
    // therefore survive together, unlike a fixed global random chance.
    const roll = hashString(`road-wear:${seed}:${candidate.effect}:${x},${y}`) / 0x100000000;
    if (roll >= Math.min(0.92, candidate.strength * 2.4)) continue;
    const mapping = resolveSemantic(registry, 'procedural.road-wear', {
      surface,
      effect: candidate.effect,
    });
    const tile = selectSemanticVariant(mapping, `${seed}:${candidate.effect}:${x},${y}`);
    if (tile) return { effect: candidate.effect, tile, strength: candidate.strength };
  }
  return null;
}

/** Backward-compatible grime/decay API used by small external callers. */
export function decayAt(x, y, fields, seed = '', context = {}) {
  return roadWearAt(x, y, fields, context, seed)?.tile ?? null;
}
