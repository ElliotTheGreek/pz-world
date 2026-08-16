/**
 * Laying roads on a square grid at their true bearing.
 *
 * The decision here is the one the whole map's character rests on. Project
 * Zomboid's grid is square, but its road *artwork* is not limited to the two
 * grid axes: the game ships two diagonal kerb sheets — `street_curbs_01_diag`
 * (78 tiles) and `street_curbs_01_diag_2` (79) — declared as `FloorOverlay`,
 * and vanilla uses them in roughly one in six of the Muldraugh cells that have
 * kerbs at all.
 *
 * FloorOverlay is the important word. The kerbs are painted *on top of* square
 * ground, so the walkable grid stays axis-aligned while the visible road edge
 * runs at an angle. That means a street does not have to be snapped to an axis
 * the way a building does. It can follow its real bearing as a stairstep, and
 * where the stairstep happens to run 1:1 the diagonal artwork makes it read as
 * a genuine angled kerb rather than a staircase.
 *
 * So:
 *   * roads keep their true bearing, stairstepped;
 *   * kerbs switch to the diagonal sheet on runs within `diagonalTolerance` of
 *     1:1;
 *   * buildings, which have no such escape hatch, are snapped in
 *     src/plan/buildings.js.
 *
 * The band structure — carriageway, kerb, sidewalk, verge — is Terrula's
 * (PREMISE.md §6.2), reduced from signed distance in metres to a distance in
 * whole squares, because on a fixed square grid there is no seam for the metric
 * version to prevent.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonc } from '../lib/jsonc.js';
import { FLOOR, FLOOR_FURNITURE, FLOOR_OVERLAY } from '../prefab/layers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.resolve(HERE, '../../config/roads.jsonc');

let cached = null;

export function loadRoadProfile(file = CONFIG) {
  if (cached && cached.file === file) return cached;
  const raw = readJsonc(file);
  cached = { file, ...raw, ignore: new Set(raw.ignore ?? []) };
  return cached;
}

/**
 * Classify an OSM way and work out how wide its carriageway is, in squares.
 * @returns {{cls: string, width: number}|null} null if it should not be drawn
 */
export function classifyRoad(road, profile = loadRoadProfile()) {
  const hw = road.highway;
  if (!hw || profile.ignore.has(hw)) return null;
  const spec = profile.highway[hw];
  if (!spec) return null;

  let width = spec.width;
  if (road.lanes && road.lanes > 0) {
    // OSM lane counts are more trustworthy than a class default when present.
    width = Math.max(spec.width, Math.round(road.lanes * profile.widthPerLane));
  }
  return { cls: spec.class, width: Math.max(1, Math.round(width)) };
}

/**
 * All integer squares a segment passes through, as a stairstep.
 *
 * A supercover walk rather than Bresenham: Bresenham picks one square per step
 * and leaves diagonal gaps a survivor could walk through, which is fine for
 * drawing a line and wrong for laying a road.
 */
export function walkSegment(x0, y0, x1, y1) {
  const out = [];
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);

  const dx = Math.abs(ex - x);
  const dy = Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx - dy;

  for (let guard = 0; guard < 1e6; guard++) {
    out.push([x, y]);
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    // Step in both axes when the error straddles, adding the corner square so
    // the run is 8-connected rather than diagonal-gapped.
    if (e2 > -dy && e2 < dx) {
      err += dx - dy;
      x += sx;
      out.push([x, y]);
      y += sy;
      continue;
    }
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    } else {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/**
 * Is this stretch of centreline running close enough to 45° for the diagonal
 * kerb artwork to line up?
 */
export function isDiagonalRun(dx, dy, tolerance) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 1e-6 || ay < 1e-6) return false;
  const ratio = ax > ay ? ay / ax : ax / ay;
  return ratio >= 1 - tolerance;
}

/**
 * Paint one road onto the canvas.
 *
 * @param {import('./grid.js').TileCanvas} canvas
 * @param {{points: [number,number][]}} road  centreline in world squares
 * @param {{cls: string, width: number}} spec
 * @param {{builtUp: (x:number,y:number)=>boolean, inWorld?: (x:number,y:number)=>boolean}} ctx
 */
export function paintRoad(canvas, road, spec, ctx, profile = loadRoadProfile()) {
  // A road is clipped with a vertex of slack on each side so it still reaches
  // the map edge, and its bands stack outward from the centreline, so it can
  // round to a square just outside the world. Project Zomboid indexes cells
  // from zero and has nowhere to put a negative one.
  const inWorld = ctx.inWorld ?? (() => true);
  const art = profile.tiles[spec.cls];
  if (!art) return 0;

  const bands = profile.bands;
  const half = spec.width / 2;
  const wantsSidewalk = profile.sidewalkClasses.includes(spec.cls);

  let painted = 0;
  const pts = road.points;

  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;

    const diagonal = isDiagonalRun(dx, dy, profile.diagonalTolerance);
    // Unit normal to the centreline: the direction the bands stack in.
    const nx = -dy / len;
    const ny = dx / len;

    for (const [cx, cy] of walkSegment(ax, ay, bx, by)) {
      // Walk outward from the centre in both directions, one square at a time.
      const maxOut = half + bands.kerb + (wantsSidewalk ? bands.sidewalk + bands.verge : 0);
      for (let d = -Math.ceil(maxOut); d <= Math.ceil(maxOut); d++) {
        const x = Math.round(cx + nx * d);
        const y = Math.round(cy + ny * d);
        if (!inWorld(x, y)) continue;
        const dist = Math.abs(d);

        if (dist <= half) {
          canvas.set(x, y, FLOOR, pick(art.surface, x, y));
          painted++;
          continue;
        }
        if (dist <= half + bands.kerb) {
          const kerb = diagonal && art.kerbDiag?.length ? art.kerbDiag : art.kerb;
          if (kerb?.length) {
            // Kerbs are FloorFurniture — that is where the vanilla highway
            // prefab puts them — while the diagonal sheets are declared
            // FloorOverlay, so the diagonal variant goes on that layer instead.
            const layer = kerb === art.kerbDiag ? FLOOR_OVERLAY : FLOOR_FURNITURE;
            canvas.set(x, y, layer, pick(kerb, x, y));
            painted++;
          }
          continue;
        }
        if (!wantsSidewalk || !ctx.builtUp(x, y)) continue;
        if (dist <= half + bands.kerb + bands.sidewalk) {
          if (art.sidewalk?.length) {
            canvas.set(x, y, FLOOR, pick(art.sidewalk, x, y));
            painted++;
          }
          continue;
        }
        if (art.verge?.length) {
          canvas.set(x, y, FLOOR, pick(art.verge, x, y));
          painted++;
        }
      }
    }
  }

  return painted;
}

/**
 * Choose a variant deterministically from position rather than from a random
 * stream, so that repainting a road — or regenerating the whole city — lays the
 * same tile on the same square.
 */
function pick(list, x, y) {
  if (!list?.length) return null;
  if (list.length === 1) return list[0];
  const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
  return list[h % list.length];
}
