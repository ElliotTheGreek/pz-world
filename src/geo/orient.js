/**
 * Choosing which way the city faces, and which way each building faces.
 *
 * This is the heart of the port. Project Zomboid draws walls only on the north
 * and west edges of a square, so a building can occupy one of four
 * orientations and nothing between. Real buildings sit at whatever angle their
 * street does. Something has to give, and the whole art is in giving as little
 * as possible.
 *
 * Two decisions, at two scales:
 *
 *   1. **The world bearing.** Rotate the entire city so that its commonest
 *      street direction lands on the grid axes. In a gridiron town this is
 *      nearly free and almost every building ends up square to its street. It
 *      is one number and it buys more than anything else here.
 *
 *   2. **Per-building snap.** Fit an oriented bounding box to each footprint,
 *      then rotate it to the nearest quarter-turn *of the already-rotated
 *      world*. What is left over after step 1 is genuinely unavoidable.
 *
 * Roads are not snapped at all — they follow their true bearing as a stairstep
 * and get diagonal kerb artwork where the steps run 1:1. See src/plan/roads.js.
 */

/** Bearing of a segment in degrees, 0 = +x (east), increasing clockwise on screen. */
export function segmentBearing(x1, y1, x2, y2) {
  return (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
}

/** Fold a bearing into [0, 90) — the four quarter-turns are indistinguishable here. */
export function foldToQuarter(deg) {
  let d = deg % 90;
  if (d < 0) d += 90;
  return d;
}

/**
 * The dominant street bearing of a road network, in degrees, folded to [0, 90).
 *
 * Segments are weighted by length, so a long arterial counts for more than a
 * cul-de-sac, and the histogram is built on the doubled angle so that a
 * bearing and its perpendicular reinforce rather than cancel — a gridiron city
 * has streets running both ways and both are evidence for the same grid.
 *
 * @param {{points: [number, number][]}[]} ways  in local metres
 * @param {number} bins
 */
export function dominantBearing(ways, bins = 360) {
  const hist = new Float64Array(bins);
  let total = 0;

  for (const way of ways) {
    const pts = way.points;
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1];
      const [x2, y2] = pts[i];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1) continue;
      const angle = foldToQuarter(segmentBearing(x1, y1, x2, y2));
      const bin = Math.min(bins - 1, Math.floor((angle / 90) * bins));
      hist[bin] += len;
      total += len;
    }
  }

  if (!total) return 0;

  // Smooth before taking the peak. Raw bins are noisy and a one-bin spike from
  // a single long straight would otherwise decide the whole city's rotation.
  const smooth = new Float64Array(bins);
  const window = Math.max(1, Math.round(bins / 60));
  for (let i = 0; i < bins; i++) {
    let sum = 0;
    for (let d = -window; d <= window; d++) sum += hist[(i + d + bins) % bins];
    smooth[i] = sum;
  }

  let best = 0;
  for (let i = 1; i < bins; i++) if (smooth[i] > smooth[best]) best = i;

  // Refine by taking the length-weighted circular mean within the winning
  // window, so the answer is not quantised to the bin width.
  let sx = 0;
  let sy = 0;
  for (let d = -window; d <= window; d++) {
    const i = (best + d + bins) % bins;
    const a = ((i + 0.5) / bins) * 90;
    // Quadruple the angle: the space is 90°-periodic, so ×4 maps it onto a
    // full circle where a circular mean is well defined.
    sx += smooth[i] * Math.cos((a * 4 * Math.PI) / 180);
    sy += smooth[i] * Math.sin((a * 4 * Math.PI) / 180);
  }
  const mean = (Math.atan2(sy, sx) * 180) / Math.PI / 4;
  return foldToQuarter(mean);
}

/**
 * How well a road network fits an axis-aligned grid once rotated by `bearing`.
 * Returns the length-weighted fraction of road within `tolDeg` of an axis —
 * a single number for "did the rotation help", reported by the generator.
 */
export function gridAlignment(ways, bearing, tolDeg = 8) {
  let aligned = 0;
  let total = 0;
  for (const way of ways) {
    const pts = way.points;
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1];
      const [x2, y2] = pts[i];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1) continue;
      const off = foldToQuarter(segmentBearing(x1, y1, x2, y2) - bearing);
      const dev = Math.min(off, 90 - off);
      total += len;
      if (dev <= tolDeg) aligned += len;
    }
  }
  return total ? aligned / total : 0;
}

/**
 * Minimum-area oriented bounding box of a polygon, by rotating callipers over
 * the convex hull.
 *
 * A building's footprint is not a rectangle, but the prefab that replaces it
 * is, so what we actually need from the footprint is "which rectangle, at which
 * angle, best stands in for this shape".
 *
 * @param {[number, number][]} points
 * @returns {{cx: number, cy: number, w: number, h: number, angle: number}}
 *   `angle` in degrees; `w` is the extent along that angle.
 */
export function orientedBounds(points) {
  const hull = convexHull(points);
  if (hull.length < 3) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      w: maxX - minX,
      h: maxY - minY,
      angle: 0,
    };
  }

  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    const edge = Math.hypot(x2 - x1, y2 - y1);
    if (edge < 1e-9) continue;
    const ux = (x2 - x1) / edge;
    const uy = (y2 - y1) / edge;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [px, py] of hull) {
      const u = px * ux + py * uy;
      const v = -px * uy + py * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = w * h;
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        area,
        w,
        h,
        cx: cu * ux - cv * uy,
        cy: cu * uy + cv * ux,
        angle: (Math.atan2(uy, ux) * 180) / Math.PI,
      };
    }
  }

  const { area, ...rest } = best;
  return rest;
}

/** Andrew's monotone chain. */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Snap a footprint to the grid.
 *
 * Returns the axis-aligned square extent the building will occupy and how many
 * quarter-turns its prototype needs. `residualDeg` is what the snap cost — how
 * far the building had to twist — and the generator reports its distribution,
 * because that number is the honest measure of how well a city suits this port.
 *
 * @param {[number, number][]} pointsInTiles footprint in tile coordinates
 */
export function snapFootprint(pointsInTiles) {
  const obb = orientedBounds(pointsInTiles);

  // Fold to [0,90) and pick the nearest axis. An OBB's "long side" angle and
  // that angle plus 90° describe the same rectangle, so only the quarter
  // matters.
  const folded = foldToQuarter(obb.angle);
  const residual = folded <= 45 ? folded : folded - 90;

  // Extent along the grid after the snap: if the box was closer to 90° than 0°
  // its width and height exchange roles.
  const swap = folded > 45;
  const w = swap ? obb.h : obb.w;
  const h = swap ? obb.w : obb.h;

  // Which quarter-turn of the prototype lines its long side up with the
  // building's long side. Prototypes are stored in their extracted
  // orientation, so this is chosen later against the actual prototype's
  // aspect; here we only report the building's own quarter.
  const quarter = ((Math.round(obb.angle / 90) % 4) + 4) % 4;

  return {
    cx: obb.cx,
    cy: obb.cy,
    w,
    h,
    quarter,
    residualDeg: residual,
    angle: obb.angle,
  };
}
