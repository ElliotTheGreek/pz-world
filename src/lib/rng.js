/**
 * Deterministic randomness.
 *
 * Terrula's second first-principle is that an untouched piece of world is a
 * pure function of its address plus a version bundle (PREMISE.md §2). The same
 * rule applies here for a different reason: a player who regenerates their city
 * after tweaking one config value should not get an entirely different town,
 * and two players with the same seed and bbox must get the same map or they
 * cannot play together.
 *
 * So nothing in the pipeline may call Math.random(). Every choice is drawn
 * from a stream keyed by something stable — usually a building's geometry hash
 * (Terrula decision D16), never its index in an array, because array order
 * changes when a source updates and would reshuffle the whole town.
 */

/** FNV-1a, 32-bit. Small, fast, and good enough to key a PRNG. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A stable identity for a piece of geometry: the hash of its vertices
 * quantised to ~1 cm. Deliberately *not* a source id — OpenStreetMap way ids
 * change when a mapper splits a way, and a building whose identity moved would
 * regenerate with a different interior for no visible reason.
 *
 * @param {[number, number][]} points  lon/lat or metres, consistently
 */
export function hashGeometry(points) {
  let s = '';
  for (const [x, y] of points) {
    s += `${Math.round(x * 1e7)},${Math.round(y * 1e7)};`;
  }
  return hashString(s);
}

/**
 * mulberry32 — one of the better small 32-bit generators, and short enough
 * that its behaviour is auditable.
 */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Integer in [0, n). */
  rng.int = (n) => Math.floor(rng() * n);
  /** Uniform pick. */
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  /**
   * Weighted pick. `weight` defaults to a `weight` property, so a table of
   * `{name, weight}` works without a mapper.
   */
  rng.weighted = (arr, weight = (x) => x.weight ?? 1) => {
    let total = 0;
    for (const x of arr) total += weight(x);
    let r = rng() * total;
    for (const x of arr) {
      r -= weight(x);
      if (r <= 0) return x;
    }
    return arr[arr.length - 1];
  };
  /** Fisher-Yates, in place, using this stream. */
  rng.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  return rng;
}

/**
 * A stream for one named purpose within one seeded world. Mixing the world
 * seed with a label means adding a new random decision somewhere does not
 * shift every decision made after it.
 */
export function streamFor(worldSeed, ...labels) {
  return makeRng(hashString(`${worldSeed}|${labels.join('|')}`));
}
