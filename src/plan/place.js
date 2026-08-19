/**
 * Choosing a real building for a real footprint.
 *
 * Two things have to be true at once for a generated town to read as the place it came
 * from: a footprint gets a building of the right **type** — the supermarket on the corner
 * becomes a shop, not a bungalow — and one of roughly the right **size and orientation**,
 * so the street still looks like the street.
 *
 * Type arrives from OpenStreetMap, already decided from the tags. Size and orientation
 * come from the oriented bounding box, snapped to a quarter turn because Project Zomboid
 * has no other option for a wall.
 *
 * This is the authored-cell counterpart of `placeBuildings` in `buildings.js`. The
 * fitting rules are the same; what differs is what gets placed — a whole building with
 * every storey, its roof and its rooms, instead of a four-layer ground-floor prefab.
 */

import { snapFootprint } from '../geo/orient.js';
import { hashString } from '../lib/rng.js';
import { readBuilding } from '../extract/building.js';
import { rotateBlock } from '../prefab/block.js';

/**
 * Where to look when a class has nothing that fits, ordered by how little the
 * substitution lies about the place. A clinic standing in for a hospital is a smaller
 * untruth than a house standing in for one.
 */
export const FALLBACK = {
  medical: ['office', 'civic', 'house'],
  education: ['office', 'civic'],
  civic: ['office', 'church'],
  fire: ['garage', 'industrial'],
  police: ['office', 'civic'],
  church: ['civic', 'house'],
  grocery: ['retail'],
  restaurant: ['retail', 'bar'],
  bar: ['restaurant', 'retail'],
  gas_station: ['retail', 'garage'],
  apartment: ['office', 'house'],
  warehouse: ['industrial', 'garage'],
  industrial: ['warehouse', 'garage'],
  retail: ['office', 'grocery'],
  office: ['retail'],
  farm: ['shed', 'garage'],
  garage: ['shed'],
  house: ['shed'],
  shed: [],
  unknown: ['house', 'shed'],
};

/** Group an index by class, with each entry's four rotated footprints precomputed. */
export function indexByClass(refs) {
  const byClass = new Map();
  for (const ref of refs) {
    let list = byClass.get(ref.cls);
    if (!list) byClass.set(ref.cls, (list = []));
    list.push(ref);
  }
  return byClass;
}

/**
 * How many of the four rotations a building may be placed at.
 *
 * **One**, and that is a correctness decision rather than a limitation of the rotation
 * code — `rotateBlock` is exact, and `test/building.test.js` proves a building rotated
 * four times is the building it started as, tile for tile.
 *
 * The problem is the *artwork*. Walls are handled properly, because a wall declares its
 * facing and the catalogue names its north/west counterpart. Almost nothing else does. A
 * roof tile carries `WestRoofT`, `WestRoofB` or `WestRoofM` and there is no north
 * equivalent anywhere in the definitions; wall-mounted fixtures carry no facing at all.
 * So rotating a building turned the walls correctly and left every roof slope and light
 * switch pointing the way it originally did — 90 degrees out, which is exactly how it
 * looked in game.
 *
 * Placing unrotated costs almost nothing, measured on the Plattsburgh footprint:
 *
 *     rotations allowed   footprints with no fit   mean waste
 *     four                0                        108.2 squares
 *     one                 0                        117.3 squares
 *
 * Every footprint still finds a building and the fit is 8% looser. That is a small price
 * for buildings whose roofs face the right way, and the 74% of placements that were
 * being rotated were choosing near-arbitrarily between equally good candidates anyway —
 * the four turns came out almost exactly evenly split.
 *
 * Lifting this needs a measured rotation table for roofs and fixtures, derived from the
 * shipped maps the same way the kerb facings and the blend layout were.
 */
export const MAX_TURNS = 1;

/**
 * The best-fitting candidates for a `w x h` plot.
 *
 * A building must fit *inside* the footprint — one spilling past its own plot overwrites
 * the pavement and its neighbour — but the choice is drawn from everything near the
 * snuggest fit, or a street of identical plots becomes a street of identical houses.
 */
export function fit(byClass, cls, w, h, salt, maxTurns = MAX_TURNS) {
  const pool = byClass.get(cls);
  if (!pool?.length) return null;

  const candidates = [];
  let bestWaste = Infinity;

  for (const ref of pool) {
    for (let turns = 0; turns < maxTurns; turns++) {
      // A quarter turn transposes the footprint.
      const rw = turns % 2 === 0 ? ref.w : ref.h;
      const rh = turns % 2 === 0 ? ref.h : ref.w;
      if (rw > w || rh > h) continue;
      const waste = w * h - rw * rh;
      candidates.push({ ref, turns, w: rw, h: rh, waste });
      if (waste < bestWaste) bestWaste = waste;
    }
  }
  if (!candidates.length) return null;

  const slack = Math.max(16, bestWaste * 0.35);
  const shortlist = candidates.filter((c) => c.waste <= bestWaste + slack);
  return shortlist[hashString(`${w}x${h}:${salt}`) % shortlist.length];
}

/**
 * Place every OSM footprint.
 *
 * @param {object[]} footprints  normalised buildings, points already in world squares
 * @param {import('../extract/building.js').BuildingRef[]} refs  the library index
 * @param {object} source  a cell source from `cellSource()`
 * @param {import('../formats/tiledefs.js').TileCatalogue} cat
 * @param {{bounds: object, seed?: string|number, log?: Function}} opts
 */
export function placeAuthored(footprints, refs, source, cat, opts) {
  const log = opts.log ?? (() => {});
  const byClass = indexByClass(refs);
  const bounds = opts.bounds;
  const seed = String(opts.seed ?? 0);

  const placements = [];
  const stats = {
    placed: 0,
    tooSmall: 0,
    noPrototype: 0,
    offMap: 0,
    overlapped: 0,
    substituted: 0,
    byClass: new Map(),
    residuals: [],
  };

  // Two buildings may not share a square. Bucketed on a coarse lattice so the test
  // costs a lookup and a few rectangle comparisons rather than a scan of the town.
  const CELL = 32;
  const occupancy = new Map();
  const collides = (p) => {
    for (let gx = Math.floor(p.x / CELL); gx <= Math.floor((p.x + p.w - 1) / CELL); gx++) {
      for (let gy = Math.floor(p.y / CELL); gy <= Math.floor((p.y + p.h - 1) / CELL); gy++) {
        for (const q of occupancy.get(`${gx},${gy}`) ?? []) {
          if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) return true;
        }
      }
    }
    return false;
  };
  const claim = (p) => {
    for (let gx = Math.floor(p.x / CELL); gx <= Math.floor((p.x + p.w - 1) / CELL); gx++) {
      for (let gy = Math.floor(p.y / CELL); gy <= Math.floor((p.y + p.h - 1) / CELL); gy++) {
        const key = `${gx},${gy}`;
        if (!occupancy.has(key)) occupancy.set(key, []);
        occupancy.get(key).push(p);
      }
    }
  };

  for (const footprint of footprints) {
    const snap = snapFootprint(footprint.points);
    const w = Math.round(snap.w);
    const h = Math.round(snap.h);

    // Below this a footprint is source noise — a bin store, a map error.
    if (w < 4 || h < 4) {
      stats.tooSmall++;
      continue;
    }

    const wanted = footprint.cls ?? 'unknown';
    const chain = [wanted, ...(FALLBACK[wanted] ?? ['house', 'shed'])];
    let chosen = null;
    let usedClass = wanted;
    for (const cls of chain) {
      chosen = fit(byClass, cls, w, h, `${seed}:${footprint.fid ?? ''}`, opts.maxTurns ?? MAX_TURNS);
      if (chosen) {
        usedClass = cls;
        break;
      }
    }
    if (!chosen) {
      stats.noPrototype++;
      continue;
    }
    if (usedClass !== wanted) stats.substituted++;

    // Centre it on the footprint's own centre, so it sits where the real building
    // sits rather than in a corner of its bounding box.
    const x = Math.round(snap.cx - chosen.w / 2);
    const y = Math.round(snap.cy - chosen.h / 2);
    const placement = { x, y, w: chosen.w, h: chosen.h };

    if (x < bounds.minX || y < bounds.minY || x + chosen.w > bounds.maxX || y + chosen.h > bounds.maxY) {
      stats.offMap++;
      continue;
    }
    if (collides(placement)) {
      stats.overlapped++;
      continue;
    }
    claim(placement);

    placements.push({
      ...placement,
      ref: chosen.ref,
      turns: chosen.turns,
      cls: usedClass,
      requestedClass: wanted,
      fid: footprint.fid ?? null,
      name: footprint.name ?? null,
      tags: { ...(footprint.tags ?? {}) },
      poiFids: [...(footprint.poiFids ?? [])],
      residualDeg: Math.abs(snap.residualDeg ?? 0),
    });
    stats.placed++;
    stats.byClass.set(usedClass, (stats.byClass.get(usedClass) ?? 0) + 1);
    stats.residuals.push(Math.abs(snap.residualDeg ?? 0));
  }

  stats.residuals.sort((a, b) => a - b);
  log(
    `placed ${stats.placed} of ${footprints.length} buildings — ` +
      `${stats.substituted} used a substitute class, ${stats.noPrototype} had nothing that fits, ` +
      `${stats.overlapped} overlapped a neighbour, ${stats.tooSmall} were too small`,
  );
  return { placements, stats };
}

/**
 * Read and rotate the chosen buildings, ready for the emitter.
 *
 * Kept separate from `placeAuthored` because this is where the megabytes are: choosing
 * is cheap and can be done for the whole town at once, while reading pulls real cell
 * data off disk.
 */
export function materialise(placements, source, cat, { log = () => {}, onRead = null } = {}) {
  const out = [];
  let read = 0;
  for (const p of placements) {
    const block = rotateBlock(readBuilding(p.ref, source), cat, p.turns);
    out.push({ ...p, block });
    read++;
    if (read % 500 === 0) log(`read ${read} of ${placements.length} buildings`);
    // Finer than the log, because this is the longest stage by far and the build
    // screen is the only thing standing between the player and a frozen-looking game.
    if (onRead && read % 50 === 0) onRead(read, placements.length);
  }
  return out;
}
