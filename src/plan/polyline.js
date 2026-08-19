/**
 * Rasterising a band around a polyline, once per square and with no gaps.
 *
 * Two wrong ways to do this were both in the tree, and each produces a distinct
 * visual defect:
 *
 *   1. **Point sampling along the normal.** Walk the centreline, step outward an
 *      integer number of squares along the unit normal, round. Exact when the
 *      normal is (1,0) or (0,1) and a sieve at any other bearing: it lands twice on
 *      one square and skips the next. A diagonal street painted this way has holes
 *      in its pavement.
 *
 *   2. **Scan the polyline's bounding box.** Correct, and quadratic in the worst
 *      case that actually occurs: a clipped interstate crossing a 5,632-square
 *      world has a 31-million-square bounding box and two hundred segments, so the
 *      scan is six billion distance evaluations for a road covering forty thousand
 *      squares.
 *
 * The set of squares within `r` of a segment is a capsule. A capsule is convex, so
 * it meets any row of squares in exactly one interval, and that interval has a
 * closed form. Enumerating segment by segment costs the covered area rather than
 * the bounding box, and keeping the nearest record per square makes the result
 * identical to asking `nearestPolylinePoint` at every square in the box.
 */

/**
 * Every row a capsule of radius `r` about segment AB touches, and the exact
 * x-interval it covers there. `rowFn(y, lo, hi)` gets real-valued bounds.
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

const KEY_SPAN = 1 << 22;
const KEY_BIAS = 1 << 21;

/**
 * @typedef {{
 *   x: number, y: number,
 *   distance: number,   unsigned distance from the square to the centreline
 *   side: number,       −1 left of the direction of travel, +1 right, 0 on it
 *   lateral: number,    signed distance: `side * distance`
 *   along: number,      cumulative position along the polyline
 *   dx: number, dy: number,      local segment direction, unnormalised
 *   towardX: number, towardY: number,  from the square back to the centreline
 *   segment: number, t: number,
 *   beyondEnd: boolean,  the nearest point is a terminus and the square is past it
 * }} BandSample
 */

/**
 * Every square within `radius` of a polyline, exactly once, carrying the same
 * record `nearestPolylinePoint` would have returned for it.
 *
 * Ties resolve to the earlier position along the line, which is what makes a
 * sequence-numbered artwork run (the diagonal curb cycle) continuous across a
 * vertex instead of restarting at it.
 *
 * @param {[number,number][]} points
 * @param {number} radius
 * @param {(sample: BandSample) => void} emit
 */
export function forEachNearPolyline(points, radius, emit) {
  if (!points || points.length < 2 || !(radius >= 0)) return;
  /** @type {Map<number, BandSample>} */
  const best = new Map();
  let prefix = 0;

  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len;
    const uy = dy / len;
    const first = i === 1;
    const last = i === points.length - 1;

    capsuleRows(ax, ay, bx, by, radius, (y, lo, hi) => {
      for (let x = Math.ceil(lo); x <= Math.floor(hi); x++) {
        let t = (x - ax) * ux + (y - ay) * uy;
        let beyondEnd = false;
        if (t < 0) {
          t = 0;
          beyondEnd = first;
        } else if (t > len) {
          t = len;
          beyondEnd = last;
        }
        const px = ax + ux * t;
        const py = ay + uy * t;
        const towardX = px - x;
        const towardY = py - y;
        const distance = Math.hypot(towardX, towardY);
        if (distance > radius) continue;

        const along = prefix + t;
        // Squares can be reached from more than one segment. The key is packed
        // the same way TileCanvas packs one, so it stays an exact integer for
        // any coordinate — including the negative ones a road clipped at the
        // world edge produces before `inWorld` gets a chance to reject them.
        const key = (x + KEY_BIAS) * KEY_SPAN + (y + KEY_BIAS);
        const previous = best.get(key);
        if (previous &&
          !(distance < previous.distance - 1e-9 ||
            (Math.abs(distance - previous.distance) <= 1e-9 && along < previous.along))) {
          continue;
        }

        // Left of travel is negative. The left normal of (dx, dy) in screen
        // coordinates (+x east, +y south) is (−dy, dx), and the square's offset
        // from the nearest point is the negation of `toward`.
        const perpendicular = towardX * uy - towardY * ux;
        const side = perpendicular < 0 ? -1 : 1;
        // `distance` rather than `|perpendicular|`, so a road ends in a rounded
        // cap with concentric bands instead of a cross-section fanned out past
        // its own terminus.
        best.set(key, {
          x, y, distance, side, lateral: side * distance, perpendicular, along,
          dx, dy, towardX, towardY, segment: i - 1, t: len ? t / len : 0, beyondEnd,
        });
      }
    });
    prefix += len;
  }

  for (const sample of best.values()) emit(sample);
}

/** Total length of a polyline, in squares. */
export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < (points?.length ?? 0); i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}
