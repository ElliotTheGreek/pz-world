/**
 * Ground blending — the tiles that stop every surface boundary being a staircase.
 *
 * A generated world painted one solid tile per surface, so tarmac met grass along a
 * hard square step and there was no such thing as a corner. Vanilla does not look like
 * that: it lays a **blend overlay** on the boundary square, on top of that square's own
 * floor, showing the neighbouring surface feathering in — including diagonals.
 *
 * ## The layout is declared, not guessed
 *
 * Every blend tile carries `FloorMaterial` naming its surface, `IsFloorAttached` marking
 * it as an overlay rather than a base, and `FloorAttachmentN/S/E/W` naming the sides the
 * *other* surface lies on. Exactly 200 tiles in the install carry `IsFloorAttached` and
 * all of them are on `blends_*` sheets, so that property is the whole blend set.
 *
 * So this file derives its table from the catalogue instead of hard-coding indices. What
 * comes out is a regular structure — blocks of 16, one surface per block:
 *
 *     offset  0, 5, 6, 7   base tile, interchangeable variants
 *     offset  1  2  3  4   corner NW, SE, SW, NE
 *     offset  8  9 10 11   edge N, W, E, S
 *     offset 12 13 14 15   a second variant of N, W, E, S
 *
 * `blends_natural_01` covers Sand 0, Grass_Dark 16, Grass_Medium 32, Grass_Light 48,
 * Dirt 64, Dirt_Grass 80, Clay 96; `blends_street_01` covers Road_01..Road_07 in the
 * same shape, with Road_06 at 80 being the main asphalt; `blends_natural_02` is Water.
 * Deriving rather than transcribing means a game update that moves a tile moves the
 * table with it.
 *
 * **This depends on `tiledefs.js` merging duplicate declarations.** It used to overwrite,
 * and `tiledefinitions_noiseworks.patch.tiles.txt` re-declares many of these tiles with
 * only `FootstepMaterial` — which silently erased `FloorMaterial` and every attachment,
 * and would have produced an empty table here with no error at all.
 *
 * ## Two rules that are easy to get wrong
 *
 * Measured over 407 Muldraugh cells, both at ~100% of ~30,000 samples each:
 *
 *   1. **Diagonal-only contact is never blended.** A square whose only neighbour of the
 *      other surface is diagonal gets no overlay. There is no outer-corner tile — the
 *      four "corner" tiles are *inner* corners, for two adjacent cardinals at once.
 *   2. **Diagonals are ignored entirely** once a cardinal is set.
 *
 * ## Which square gets the overlay
 *
 * The higher-precedence surface paints onto the lower one, never the reverse — of
 * 1,113,902 blend squares in the sample, the reverse pairing occurs zero times. Grass
 * creeps onto the road; the road never creeps onto the grass.
 */

import { hashString } from '../lib/rng.js';

/** The sheets that carry blend sets. Anything else is not part of the system. */
const BLEND_SHEETS = ['blends_natural_01', 'blends_natural_02', 'blends_street_01'];

const CARDINALS = ['N', 'E', 'S', 'W'];

/** Which offsets in a block mean what, as declared by `FloorAttachment*`. */
const CORNER_OF = { NW: 'NW', SE: 'SE', SW: 'SW', NE: 'NE' };

/**
 * Who paints over whom.
 *
 * Derived from measuring which material's overlay sits on which material's base across
 * the whole sample. Higher wins. Road_06 is the bottom of the stack, which is consistent
 * with it being the asphalt everything else patches onto, and every `blends_natural_01`
 * surface outranks every `blends_street_01` one.
 */
export const PRECEDENCE = {
  Water: 99,
  Grass_Dark: 70,
  Grass_Medium: 60,
  Grass_Light: 50,
  Sand: 40,
  Dirt_Grass: 40,
  Dirt: 30,
  Road_01: 25,
  Road_02: 25,
  Road_03: 25,
  Road_04: 25,
  Road_05: 25,
  Road_07: 25,
  Road_06: 10,
};

/**
 * Blocks whose declaration cannot be trusted, both established by measurement:
 *
 *   - `blends_street_01` offsets 8-11 are declared `Road_01` but in the direction they
 *     claim, the neighbour is `Road_07` 2,076 times against `Road_01` 564.
 *   - `blends_natural_01` 112-127 is declared `Clay` but is sixteen cardinal edges with
 *     no base and no corners, breaking the block shape. It appears nowhere in Muldraugh.
 */
const SUSPECT_EDGES = new Set(['blends_street_01:0']);

/**
 * @typedef {{
 *   material: string, sheet: string, base: number,
 *   variants: number[], edge: Record<string, number[]>, corner: Record<string, number>,
 *   precedence: number,
 * }} BlendSet
 */

/**
 * Read the blend table out of the tile catalogue.
 *
 * @param {import('../formats/tiledefs.js').TileCatalogue} cat
 * @returns {Map<string, BlendSet>} keyed by `FloorMaterial`
 */
export function loadBlendSets(cat) {
  /** @type {Map<string, BlendSet>} */
  const sets = new Map();

  for (const sheet of BLEND_SHEETS) {
    const tiles = cat.tilesets.get(sheet);
    if (!tiles) continue;

    /** block index -> { material, variants, edge, corner } */
    const blocks = new Map();

    for (const t of tiles) {
      const material = t.props.FloorMaterial;
      if (!material || !Number.isFinite(t.index)) continue;

      const block = Math.floor(t.index / 16);
      const offset = t.index % 16;
      let b = blocks.get(block);
      if (!b) {
        blocks.set(block, (b = { material, variants: [], edge: { N: [], E: [], S: [], W: [] }, corner: {} }));
      }

      const dirs = CARDINALS.filter((d) => `FloorAttachment${d}` in t.props);

      if (!('IsFloorAttached' in t.props)) {
        // A base tile: full coverage, no attachment, several interchangeable variants.
        b.variants.push(offset);
      } else if (dirs.length === 2) {
        const key = dirs.includes('N')
          ? (dirs.includes('W') ? 'NW' : 'NE')
          : (dirs.includes('W') ? 'SW' : 'SE');
        b.corner[CORNER_OF[key]] = offset;
      } else if (dirs.length === 1) {
        if (!SUSPECT_EDGES.has(`${sheet}:${block}`)) b.edge[dirs[0]].push(offset);
      }
    }

    for (const [block, b] of blocks) {
      // A block with no base tile is not a usable surface — it is the malformed
      // `blends_natural_01` 112-127 group, which has edges and nothing to put them on.
      if (!b.variants.length) continue;
      // Later sheets do not get to redefine an earlier sheet's material.
      if (sets.has(b.material)) continue;

      b.variants.sort((p, q) => p - q);
      for (const d of CARDINALS) b.edge[d].sort((p, q) => p - q);

      sets.set(b.material, {
        material: b.material,
        sheet,
        base: block * 16,
        variants: b.variants,
        edge: b.edge,
        corner: b.corner,
        precedence: PRECEDENCE[b.material] ?? 0,
      });
    }
  }

  return sets;
}

/** Deterministic per-square choice, so a rebuilt city lays the same tile again. */
function pick(list, x, y, salt) {
  if (list.length <= 1) return list[0];
  const h = hashString(`${x},${y},${salt}`);
  return list[h % list.length];
}

/**
 * The solid tile for a surface on this square, chosen from its base variants.
 *
 * ## This is a per-square dither, and that is measured rather than assumed
 *
 * It used to choose from a low-frequency field on the reasoning that a
 * per-square hash would read as a uniform dither over a whole city. The
 * reasoning was sound and the premise was wrong, and the cost was the flattest
 * thing about a generated world.
 *
 * Sampling every base tile at level 0 across 24 Muldraugh cells — 1,386,631
 * squares — settles it. Vanilla picks the four variants of a block **uniformly
 * per square**:
 *
 *     block 1 Grass_Dark    919,146   offsets 0/5/6/7 at 25.2 25.0 24.8 25.1 %
 *     block 2 Grass_Medium  287,110                      25.0 24.9 24.9 25.2 %
 *     block 3 Grass_Light    96,640                      25.1 25.1 24.8 25.0 %
 *
 *     run of one variant along a row:  mean 1.30 squares, median 1, p90 2
 *     run of one *material* along a row: mean 11.02, median 3, p90 19
 *
 * So the fine mottle a player sees is the four variants shuffled square by
 * square, and the patches are the *material* changing every ten squares or so.
 * Choosing variants from a 110-square field reached only two of the four and
 * changed them once a screen, which is precisely the reported symptom: flat
 * grass everywhere. The patch structure belongs to `naturalSurfaceAt` in
 * `src/plan/surfaces.js`, and that is where it now lives.
 *
 * @param {BlendSet} set
 * @param {number} x
 * @param {number} y
 */
export function baseTile(set, x, y) {
  return `${set.sheet}_${set.base + pick(set.variants, x, y, 'base')}`;
}

/**
 * The blend overlays for one square.
 *
 * @param {Map<string, BlendSet>} sets
 * @param {(x: number, y: number) => string|null} materialAt  surface of a square
 * @param {number} x
 * @param {number} y
 * @returns {string[]} tile names, in no particular order; usually empty
 */
export function blendOverlays(sets, materialAt, x, y) {
  const mine = materialAt(x, y);
  if (!mine) return [];
  const self = sets.get(mine);
  const myRank = self ? self.precedence : 0;

  // Only the four cardinals matter. A neighbour that touches this square only at a
  // corner produces nothing at all — measured at 100% across ~30,000 samples per
  // diagonal, and there is no tile in the sheets that would draw it.
  const neighbour = {
    N: materialAt(x, y - 1),
    E: materialAt(x + 1, y),
    S: materialAt(x, y + 1),
    W: materialAt(x - 1, y),
  };

  /** other material -> the cardinals it occupies */
  const claims = new Map();
  for (const d of CARDINALS) {
    const m = neighbour[d];
    if (!m || m === mine) continue;
    const other = sets.get(m);
    if (!other || other.precedence <= myRank) continue;
    let list = claims.get(m);
    if (!list) claims.set(m, (list = []));
    list.push(d);
  }
  if (!claims.size) return [];

  const out = [];
  for (const [material, dirs] of claims) {
    const set = sets.get(material);
    const has = (d) => dirs.includes(d);
    const covered = new Set();

    // Inner corners first: one tile draws two cardinals, so the straight edges for
    // those sides must not also be laid or they would double up.
    for (const [key, a, b] of [
      ['NE', 'N', 'E'],
      ['SE', 'S', 'E'],
      ['SW', 'S', 'W'],
      ['NW', 'N', 'W'],
    ]) {
      if (has(a) && has(b) && set.corner[key] !== undefined) {
        out.push(`${set.sheet}_${set.base + set.corner[key]}`);
        covered.add(a);
        covered.add(b);
      }
    }

    for (const d of dirs) {
      if (covered.has(d)) continue;
      const options = set.edge[d];
      if (!options.length) continue;
      out.push(`${set.sheet}_${set.base + pick(options, x, y, `edge${d}`)}`);
    }
  }
  return out;
}
