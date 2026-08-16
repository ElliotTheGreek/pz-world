/**
 * What each square of the world is made of, before anything is drawn.
 *
 * The authored route needs one answer per square — grass, tarmac, pavement, water —
 * and it needs it *before* it lays a tile, because three later passes all read it and
 * must agree: the base tile, the blend overlays between surfaces, and the biome map
 * that stops the game regenerating what we wrote.
 *
 * ## Bands are filled, not sampled
 *
 * `paintRoad` in `roads.js` walks the centreline and then steps outward an integer
 * number of squares along the unit normal:
 *
 *     const x = Math.round(cx + nx * d);
 *     const y = Math.round(cy + ny * d);
 *
 * On an axis-aligned road the normal is (1,0) or (0,1) and that is exact. On any other
 * bearing it is a point sample of a continuous band, so it lands on the same square
 * twice in places and skips one in others — which is a pavement with holes in it, and
 * is what the diagonal streets looked like in game.
 *
 * The set of squares within `r` of a segment is a capsule; a capsule is convex, so it
 * meets any row of squares in exactly one interval. That interval is computed in closed
 * form here and every square in it is emitted, once. No gaps, no double writes, and the
 * round ends close the notch that used to open on the outside of every corner.
 */

import { SurfaceGrid } from '../emit/world.js';
import { classifyRoad, loadRoadProfile } from './roads.js';

/**
 * Every row a capsule of radius `r` about segment AB touches, and the exact x-interval
 * it covers there. `rowFn(y, lo, hi)` gets real-valued bounds.
 */
export function capsuleRows(x0, y0, x1, y1, r, rowFn) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);

  let cx = null;
  let cy = null;
  if (len > 1e-9) {
    const nx = (-dy / len) * r;
    const ny = (dx / len) * r;
    cx = [x0 + nx, x1 + nx, x1 - nx, x0 - nx];
    cy = [y0 + ny, y1 + ny, y1 - ny, y0 - ny];
  }

  for (let y = Math.ceil(Math.min(y0, y1) - r); y <= Math.floor(Math.max(y0, y1) + r); y++) {
    let lo = Infinity;
    let hi = -Infinity;

    if (cx) {
      let j = 3;
      for (let i = 0; i < 4; i++) {
        const yi = cy[i];
        const yj = cy[j];
        // Half-open crossing rule; an edge lying exactly on the row contributes
        // nothing and the end discs cover that case.
        if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
          const x = cx[i] + ((y - yi) / (yj - yi)) * (cx[j] - cx[i]);
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
        j = i;
      }
    }

    for (const [ex, ey] of [[x0, y0], [x1, y1]]) {
      const inside = r * r - (y - ey) * (y - ey);
      if (inside < 0) continue;
      const hw = Math.sqrt(inside);
      if (ex - hw < lo) lo = ex - hw;
      if (ex + hw > hi) hi = ex + hw;
    }

    if (lo <= hi) rowFn(y, lo, hi);
  }
}

/**
 * Every square within `r` of a polyline, with its true distance to the centreline.
 *
 * `emit(x, y, dist)`.
 */
export function forEachInBand(points, r, emit) {
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uy = dy / len;

    capsuleRows(ax, ay, bx, by, r, (y, lo, hi) => {
      for (let x = Math.ceil(lo); x <= Math.floor(hi); x++) {
        // Nearest point on the segment, ends clamped so the caps are discs.
        let t = (x - ax) * ux + (y - ay) * uy;
        if (t < 0) t = 0;
        else if (t > len) t = len;
        const dist = Math.hypot(ax + ux * t - x, ay + uy * t - y);
        if (dist <= r) emit(x, y, dist);
      }
    });
  }
}

/** Land-cover pixel to a surface name. Anything unlisted keeps the default. */
const COVER_SURFACE = {
  0: 'water',
  64: 'meadow',
  115: 'grass',
  128: 'meadow',
  141: 'grassLight',
  200: 'road', // car parks are paved
  204: 'grassLight',
  217: 'grassLight',
  254: 'dirt',
  255: 'grass',
};

/**
 * Decide the surface of every square in the footprint.
 *
 * Later passes overwrite earlier ones, so the order is least to most specific:
 * default ground, then land cover, then car parks, then roads, then pavements.
 *
 * @param {object} plan from src/plan/index.js
 * @param {{default?: string, log?: Function}} [opts]
 */
export function buildSurfaces(plan, opts = {}) {
  const log = opts.log ?? (() => {});
  const profile = loadRoadProfile();
  const bounds = plan.meta.bounds;
  const surfaces = new SurfaceGrid(bounds);
  surfaces.fill(opts.default ?? 'grass');

  // ---- land cover, largest first so a park inside a district wins -------
  const covers = [...plan.ground.polygons ?? []].sort((a, b) => (b.area ?? 0) - (a.area ?? 0));
  let coverSquares = 0;
  for (const cover of covers) {
    const surface = COVER_SURFACE[cover.pixel];
    if (!surface) continue;
    coverSquares += fillPolygon(surfaces, cover.points, surface);
  }
  log(`land cover: ${covers.length} areas over ${coverSquares} squares`);

  // ---- roads ------------------------------------------------------------
  const builtUp = plan.builtUp ?? (() => true);
  let carriageway = 0;
  let pavement = 0;

  // Every carriageway before any pavement. Painting a road at a time means the
  // second road at a junction lays its pavement across the first road's tarmac.
  for (const road of plan.roads.ways ?? []) {
    const spec = classifyRoad(road, profile);
    if (!spec) continue;
    forEachInBand(road.points, spec.width / 2, (x, y) => {
      surfaces.set(x, y, spec.cls === 'track' ? 'gravel' : 'road');
      carriageway++;
    });
  }
  for (const road of plan.roads.ways ?? []) {
    const spec = classifyRoad(road, profile);
    if (!spec || !profile.sidewalkClasses.includes(spec.cls)) continue;
    const half = spec.width / 2;
    // One square of pavement: measured across 25,705 Muldraugh kerb squares,
    // 82.6% of pavements are exactly that wide.
    forEachInBand(road.points, half + 1, (x, y, dist) => {
      if (dist <= half) return;
      if (!builtUp(x, y)) return;
      if (surfaces.get(x, y) === 'road') return; // never over a carriageway
      surfaces.set(x, y, 'pavement');
      pavement++;
    });
  }
  log(`roads: ${carriageway} squares of carriageway, ${pavement} of pavement`);

  return surfaces;
}

/** Scanline-fill a polygon into the surface grid. */
export function fillPolygon(surfaces, points, surface) {
  if (points.length < 3) return 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of points) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  minY = Math.max(minY, surfaces.minY);
  maxY = Math.min(maxY, surfaces.minY + surfaces.h - 1);

  let painted = 0;
  for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
    const xs = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi === yj) continue;
      if (y >= Math.min(yi, yj) && y < Math.max(yi, yj)) {
        xs.push(xj + ((y - yj) / (yi - yj)) * (xi - xj));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(Math.ceil(xs[k]), surfaces.minX);
      const to = Math.min(Math.floor(xs[k + 1]), surfaces.minX + surfaces.w - 1);
      for (let x = from; x <= to; x++) {
        surfaces.set(x, y, surface);
        painted++;
      }
    }
  }
  return painted;
}
