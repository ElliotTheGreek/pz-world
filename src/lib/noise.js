/**
 * Seeded gradient noise, and the two fields built from it.
 *
 * Written rather than depended on, like every other format and codec here — there are no
 * npm dependencies in this project and this is sixty lines.
 *
 * Two fields come out of it and they do different jobs:
 *
 *   - **fBm** — fractional Brownian motion, several octaves of gradient noise summed with
 *     halving amplitude. Smooth, blobby, no structure to it. This is what woodland looks
 *     like from above: dense stands with clearings between them.
 *   - **Ridged** — `1 - |2n - 1|` per octave, which folds the field at its midline so the
 *     zero crossings become sharp crests. This is what an outcrop looks like: rock follows
 *     a line, not a cloud.
 *
 * Both return 0..1.
 */

/**
 * A permutation table from a string seed, so the same city regenerates identically.
 *
 * Fisher-Yates driven by a 32-bit xorshift, which is enough for a gradient table and
 * avoids pulling in a PRNG for one use.
 */
function permutation(seed) {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619) >>> 0;
  }
  if (state === 0) state = 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };

  const p = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = next() % (i + 1);
    const t = base[i];
    base[i] = base[j];
    base[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return p;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + t * (b - a);

/** The eight axis/diagonal gradients of 2D Perlin. */
function grad(hash, x, y) {
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

/**
 * A noise field over the world.
 *
 * @param {string} seed
 */
export class Noise {
  constructor(seed = '') {
    this.p = permutation(String(seed));
  }

  /** Classic 2D Perlin, in -1..1. */
  at(x, y) {
    const p = this.p;
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);

    const aa = p[p[xi] + yi];
    const ab = p[p[xi] + yi + 1];
    const ba = p[p[xi + 1] + yi];
    const bb = p[p[xi + 1] + yi + 1];

    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    // The gradients above reach ±2 on the diagonals, so normalise to -1..1.
    return lerp(x1, x2, v) / 2;
  }

  /**
   * Fractional Brownian motion, 0..1, mean about 0.5.
   *
   * @param {number} x world square
   * @param {number} y world square
   * @param {number} scale squares per unit of noise — the size of a stand of trees
   */
  fbm(x, y, scale = 80, octaves = 4) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1 / scale;
    for (let i = 0; i < octaves; i++) {
      sum += this.at(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return (sum / norm + 1) / 2;
  }

  /**
   * Ridged multifractal, 0..1, crests near 1.
   *
   * Folding each octave at its midline turns the zero crossings into sharp lines, which
   * is what puts boulders along an outcrop instead of sprinkling them evenly.
   */
  ridged(x, y, scale = 40, octaves = 3) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1 / scale;
    for (let i = 0; i < octaves; i++) {
      const n = this.at(x * freq, y * freq);
      sum += (1 - Math.abs(n) * 2) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    const v = sum / norm;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
}
