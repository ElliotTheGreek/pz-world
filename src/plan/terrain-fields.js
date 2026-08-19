/**
 * Deterministic, coordinate-stable fields used by terrain generation.
 *
 * Every value is a pure function of the world seed, field name and absolute world-square
 * coordinates. There is no mutable PRNG state, chunk origin or traversal state, so a
 * square has the same value whether it is generated alone, in another cell, or after
 * any other square.
 */

import { Noise } from '../lib/noise.js';

/**
 * Frequencies and octave mixes are deliberately different by concern. Independent seed
 * namespaces prevent (for example) wet ground from always becoming worn road or dense
 * woodland merely because those passes happened to sample the same noise.
 */
export const TERRAIN_FIELD_SPECS = Object.freeze({
  grass: Object.freeze({ scale: 110, octaves: 3, detailScale: 24, detailWeight: 0.14, patchWeight: 0.12 }),
  dirt: Object.freeze({ scale: 150, octaves: 4, detailScale: 38, detailWeight: 0.18, patchWeight: 0.14 }),
  vegetation: Object.freeze({ scale: 90, octaves: 3, detailScale: 28, detailWeight: 0.10, patchWeight: 0.08 }),
  moisture: Object.freeze({ scale: 260, octaves: 4, detailScale: 70, detailWeight: 0.13, patchWeight: 0.08 }),
  // Road wear shares the material field's scale, because vanilla's asphalt
  // patches are the same size as its grass patches: a run of one road material
  // along a row has a median of 4 squares and a 90th percentile of 15.
  wear: Object.freeze({ scale: 18, octaves: 3, detailScale: 7, detailWeight: 0.18, patchWeight: 0 }),
  patch: Object.freeze({ scale: 32, octaves: 3, detailScale: 9, detailWeight: 0.25, patchWeight: 0 }),
  // Which *material* a natural square is made of — dark grass, medium, light,
  // dirt-grass. Measured across 24 Muldraugh cells, a run of one material along
  // a row has a median of 3 squares and a 90th percentile of 19; every coarser
  // field produced one material per screen, which is the flat ground the first
  // builds had. See docs/ARTWORK-TASKS.md.
  material: Object.freeze({ scale: 16, octaves: 3, detailScale: 6, detailWeight: 0.18, patchWeight: 0 }),
});

/**
 * Standard deviation of each field, measured over a 600-square sample.
 *
 * Summing octaves narrows the distribution — the central limit theorem applies
 * to fBm like anything else — so a raw field sits in a band about 0.5 and
 * comparing it directly against cumulative shares selects one outcome for the
 * whole world. That is exactly what happened to the ground: two of four grass
 * variants were unreachable and the boundary between materials never moved.
 * `fieldPercentile` converts a value to its rank, and these are what it needs.
 */
export const FIELD_SIGMA = Object.freeze({
  grass: 0.0325,
  dirt: 0.0282,
  vegetation: 0.0355,
  moisture: 0.0312,
  wear: 0.0366,
  patch: 0.0347,
  material: 0.0369,
});

/**
 * Approximate the normal CDF, so a narrow field becomes a uniform 0..1 rank.
 *
 * Abramowitz & Stegun 7.1.26; the error is below 1.5e-7, which is far tighter
 * than the sample the sigmas came from.
 */
export function fieldPercentile(value, sigma = 0.03) {
  const z = (value - 0.5) / (sigma * Math.SQRT2);
  const sign = z < 0 ? -1 : 1;
  const a = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * a);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
  return (1 + erf) / 2;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class TerrainFields {
  constructor(seed = '') {
    this.seed = String(seed);
    this.fields = new Map();
    for (const name of Object.keys(TERRAIN_FIELD_SPECS)) {
      // Broad shape and local structure use separate permutations. Combining them is
      // still stateless and avoids a field looking like a magnified copy of itself.
      this.fields.set(name, {
        broad: new Noise(`terrain:${name}:broad:${this.seed}`),
        detail: new Noise(`terrain:${name}:detail:${this.seed}`),
      });
    }
  }

  /** Sample a named field at absolute world-square coordinates, returning 0..1. */
  at(name, x, y) {
    const spec = TERRAIN_FIELD_SPECS[name];
    const field = this.fields.get(name);
    if (!spec || !field) throw new Error(`Unknown terrain field: ${name}`);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new TypeError(`Terrain coordinates must be finite, got ${x},${y}`);
    }
    const broad = field.broad.fbm(x, y, spec.scale, spec.octaves);
    const detail = field.detail.fbm(x, y, spec.detailScale, 2);
    const patchSpec = TERRAIN_FIELD_SPECS.patch;
    const patchField = this.fields.get('patch');
    const patch = name === 'patch'
      ? 0.5
      : patchField.broad.fbm(x, y, patchSpec.scale, patchSpec.octaves);
    const broadWeight = 1 - spec.detailWeight - spec.patchWeight;
    return clamp01(broad * broadWeight + detail * spec.detailWeight + patch * spec.patchWeight);
  }

  /** A named field's value as its rank in the field's own distribution, 0..1. */
  percentile(name, x, y) {
    return fieldPercentile(this.at(name, x, y), FIELD_SIGMA[name] ?? 0.03);
  }

  /** Noise-compatible view for existing consumers that call `fbm(x, y)`. */
  view(name) {
    return { fbm: (x, y) => this.at(name, x, y) };
  }
}

export function terrainFields(seed = '') {
  return new TerrainFields(seed);
}
