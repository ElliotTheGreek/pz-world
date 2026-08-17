#!/usr/bin/env node
/**
 * Replay the mod's world build outside the game, against a real helper payload.
 *
 * There is no Lua interpreter on a modding machine (DEV_GUIDE §3), and the only
 * way to see the result of a change to Roads.lua or Build.lua used to be a full
 * launch: quit the game, reinstall the mod, start a new world, walk to a
 * junction. That is a ten-minute round trip for a one-line change, and it is
 * how three wrong ideas about the road bands each cost an afternoon.
 *
 * So the geometry half of the pipeline is reimplemented here, deliberately as a
 * transcription rather than a rewrite — same band radii, same phase order, same
 * patch lattice, same 32-square occupancy buckets — and asked the questions
 * that actually decide whether the world will look right:
 *
 *   - do any two static modules overlap?  (they must not: WorldGenChunk takes
 *     the first module covering a square and discards the rest)
 *   - how many building squares would a road patch overwrite?
 *   - how many pavement squares end up on top of somebody's carriageway?
 *
 * This is a model, not the mod, and DEV_GUIDE §6.2 applies: a passing model is
 * a hypothesis until the game agrees. It is here to catch the failures that are
 * geometric, which is most of them.
 *
 *   node tools/simulate.js [path/to/pzworld_data.txt]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEG = 180 / Math.PI;

// Must match Config.lua.
const CANVAS_CELLS = 80;
const CELL_SIZE = 256;
const WORLD = CANVAS_CELLS * CELL_SIZE;
const ORIGIN = Math.floor(WORLD / 2);

// Must match Canvas.lua / Roads.lua / Buildings.lua / Ground.lua.
const PATCH = 32;
const BLOCK = 16;
const OCCUPANCY_CELL = 32;
const KERB_BAND = 1;
const PAVEMENT_BAND = 1;

const SIDEWALK_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'residential']);
const HAS_ART = new Set([...SIDEWALK_CLASSES, 'service', 'track', 'footway', 'cycleway']);

// ------------------------------------------------------------------- payload

export function readPayload(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const roads = [];
  const buildings = [];
  const ground = [];

  let i = 0;
  for (; i < lines.length; i++) if (lines[i] === '') { i++; break; }

  for (; i < lines.length; i++) {
    const header = lines[i];
    if (!header || header === 'end') continue;
    const m = /^(\w)\s+(\S+)\s+(\S+)/.exec(header);
    if (!m) continue;
    const pts = (lines[++i] || '')
      .trim()
      .split(' ')
      .map((p) => p.split(',').map(Number))
      .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length < 2) continue;
    if (m[1] === 'R') roads.push({ cls: m[2], width: Number(m[3]) || 4, pts });
    else if (m[1] === 'B') buildings.push({ cls: m[2], pts });
    else if (m[1] === 'G') ground.push({ pixel: Number(m[2]), pts });
  }
  return { roads, buildings, ground };
}

// ------------------------------------------------------- orientation (Geo.lua)

const foldQuarter = (d) => ((d % 90) + 90) % 90;

export function dominantBearing(roads, bins = 180) {
  const hist = new Array(bins).fill(0);
  let total = 0;
  for (const r of roads) {
    for (let k = 1; k < r.pts.length; k++) {
      const [x1, y1] = r.pts[k - 1];
      const [x2, y2] = r.pts[k];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1) continue;
      let bin = Math.floor((foldQuarter(Math.atan2(y2 - y1, x2 - x1) * DEG) / 90) * bins);
      if (!(bin >= 0)) bin = 0;
      if (bin >= bins) bin = bins - 1;
      hist[bin] += len;
      total += len;
    }
  }
  if (total <= 0) return 0;

  const w = Math.max(1, Math.floor(bins / 60));
  const wrap = (i) => ((i % bins) + bins) % bins;
  const smooth = hist.map((_, idx) => {
    let s = 0;
    for (let d = -w; d <= w; d++) s += hist[wrap(idx + d)];
    return s;
  });
  let best = 0;
  for (let k = 1; k < bins; k++) if (smooth[k] > smooth[best]) best = k;

  let sx = 0;
  let sy = 0;
  for (let d = -w; d <= w; d++) {
    const idx = wrap(best + d);
    const a = ((idx + 0.5) / bins) * 90;
    sx += smooth[idx] * Math.cos((a * 4) / DEG);
    sy += smooth[idx] * Math.sin((a * 4) / DEG);
  }
  return foldQuarter((Math.atan2(sy, sx) * DEG) / 4);
}

export function project(features, bearing) {
  const b = bearing / DEG;
  const cos = Math.cos(b);
  const sin = Math.sin(b);
  for (const group of features) {
    for (const f of group) {
      f.pts = f.pts.map(([e, n]) => [ORIGIN + (e * cos + n * sin), ORIGIN - (-e * sin + n * cos)]);
    }
  }
}

// --------------------------------------------------- footprints (Geo/Buildings)

function convexHull(pts) {
  const p = pts.slice().sort((a, c) => (a[0] === c[0] ? a[1] - c[1] : a[0] - c[0]));
  if (p.length < 3) return p;
  const cross = (o, a, c) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let k = p.length - 1; k >= 0; k--) {
    const q = p[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function snapFootprint(pts) {
  const hull = convexHull(pts);
  let best = null;
  if (hull.length >= 3) {
    for (let k = 0; k < hull.length; k++) {
      const a = hull[k];
      const c = hull[(k + 1) % hull.length];
      const edge = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (edge < 1e-9) continue;
      const ux = (c[0] - a[0]) / edge;
      const uy = (c[1] - a[1]) / edge;
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const q of hull) {
        const u = q[0] * ux + q[1] * uy;
        const v = -q[0] * uy + q[1] * ux;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) {
        const cu = (minU + maxU) / 2;
        const cv = (minV + maxV) / 2;
        best = {
          area,
          w: maxU - minU,
          h: maxV - minV,
          cx: cu * ux - cv * uy,
          cy: cu * uy + cv * ux,
          angle: Math.atan2(uy, ux) * DEG,
        };
      }
    }
  }
  if (!best) {
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    best = {
      cx: (Math.min(...xs) + Math.max(...xs)) / 2,
      cy: (Math.min(...ys) + Math.max(...ys)) / 2,
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
      angle: 0,
    };
  }
  const swap = foldQuarter(best.angle) > 45;
  return { cx: best.cx, cy: best.cy, w: swap ? best.h : best.w, h: swap ? best.w : best.h };
}

/** Transcription of Buildings.newOccupancy / collides / claim. */
class Occupancy {
  constructor() {
    this.buckets = new Map();
  }

  *#cells(p) {
    const C = OCCUPANCY_CELL;
    for (let gx = Math.floor(p.x / C); gx <= Math.floor((p.x + p.w - 1) / C); gx++)
      for (let gy = Math.floor(p.y / C); gy <= Math.floor((p.y + p.h - 1) / C); gy++)
        yield gx * 100000 + gy;
  }

  collides(p) {
    for (const k of this.#cells(p)) {
      for (const q of this.buckets.get(k) || []) {
        if (p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h) return true;
      }
    }
    return false;
  }

  claim(p) {
    for (const k of this.#cells(p)) {
      let list = this.buckets.get(k);
      if (!list) this.buckets.set(k, (list = []));
      list.push(p);
    }
  }
}

// ------------------------------------------------------- the canvas (Canvas.lua)

class Canvas {
  constructor() {
    this.patches = new Map();
    this.order = [];
    this.count = 0;
  }

  #patchAt(x, y) {
    const k = Math.floor(x / PATCH) * 100000 + Math.floor(y / PATCH);
    let p = this.patches.get(k);
    if (!p) {
      p = { ox: Math.floor(x / PATCH) * PATCH, oy: Math.floor(y / PATCH) * PATCH, minX: x, minY: y, maxX: x, maxY: y, layers: new Map() };
      this.patches.set(k, p);
      this.order.push(k);
    }
    if (x < p.minX) p.minX = x;
    if (y < p.minY) p.minY = y;
    if (x > p.maxX) p.maxX = x;
    if (y > p.maxY) p.maxY = y;
    return p;
  }

  set(x, y, layer, tile) {
    if (!tile) return;
    if (x < 0 || y < 0 || x >= WORLD || y >= WORLD) return;
    const p = this.#patchAt(x, y);
    let grid = p.layers.get(layer);
    if (!grid) p.layers.set(layer, (grid = new Map()));
    const slot = (y - p.oy) * PATCH + (x - p.ox);
    if (!grid.has(slot)) this.count++;
    grid.set(slot, tile);
  }

  get(x, y, layer) {
    const p = this.patches.get(Math.floor(x / PATCH) * 100000 + Math.floor(y / PATCH));
    if (!p) return null;
    const grid = p.layers.get(layer);
    if (!grid) return null;
    return grid.get((y - p.oy) * PATCH + (x - p.ox)) ?? null;
  }

  /** Boxes exactly as stepEmitting would emit them. */
  patchBoxes() {
    const out = [];
    for (const k of this.order) {
      const p = this.patches.get(k);
      if (!p.layers.size) continue;
      out.push({ x: p.minX, y: p.minY, w: p.maxX - p.minX + 1, h: p.maxY - p.minY + 1 });
    }
    return out;
  }
}

// -------------------------------------------------------- the bands (Roads.lua)

/** Transcription of Roads.capsuleRows. */
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
      if (inside >= 0) {
        const hw = Math.sqrt(inside);
        if (ex - hw < lo) lo = ex - hw;
        if (ex + hw > hi) hi = ex + hw;
      }
    }
    if (lo <= hi) rowFn(y, lo, hi);
  }
}

/** Transcription of Roads.forEachInBand. */
export function forEachInBand(road, r, emit) {
  for (let k = 1; k < road.pts.length; k++) {
    const [ax, ay] = road.pts[k - 1];
    const [bx, by] = road.pts[k];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uy = dy / len;
    capsuleRows(ax, ay, bx, by, r, (y, lo, hi) => {
      for (let x = Math.ceil(lo); x <= Math.floor(hi); x++) {
        let t = (x - ax) * ux + (y - ay) * uy;
        if (t < 0) t = 0;
        else if (t > len) t = len;
        const vx = ax + ux * t - x;
        const vy = ay + uy * t - y;
        const dist = Math.hypot(vx, vy);
        if (dist <= r) emit(x, y, dist, dist > 1e-9 ? vx / dist : 0, dist > 1e-9 ? vy / dist : 0);
      }
    });
  }
}

const KERBS = { west: 'street_curbs_01_9', east: 'street_curbs_01_11', north: 'street_curbs_01_8', south: 'street_curbs_01_10' };
const ASPHALT = 'blends_street_01_86';
const PAVEMENT = 'floors_exterior_tilesandstone_01_3';

export function kerbFor(sx, sy) {
  if (Math.abs(sx) >= Math.abs(sy)) return sx >= 0 ? KERBS.west : KERBS.east;
  return sy < 0 ? KERBS.south : KERBS.north;
}

function surfaceFor(cls) {
  if (cls === 'track') return 'blends_natural_01_64';
  if (cls === 'footway') return PAVEMENT;
  return ASPHALT;
}

// ---------------------------------------------------------------------- run

export function simulate(payload, log = console.log) {
  const { roads, buildings } = payload;
  log(`payload: ${roads.length} roads, ${buildings.length} buildings, ${payload.ground.length} ground areas`);

  const bearing = dominantBearing(roads);
  project([roads, buildings, payload.ground], bearing);
  log(`world bearing ${bearing.toFixed(2)} deg`);

  // --- buildings
  const occ = new Occupancy();
  const placements = [];
  let tooSmall = 0;
  let overlapped = 0;
  let outside = 0;
  for (const b of buildings) {
    const s = snapFootprint(b.pts);
    const w = Math.round(s.w);
    const h = Math.round(s.h);
    if (w < 4 || h < 4) { tooSmall++; continue; }
    const p = { x: Math.round(s.cx - w / 2), y: Math.round(s.cy - h / 2), w, h, cls: b.cls };
    if (p.x < 0 || p.y < 0 || p.x + p.w >= WORLD || p.y + p.h >= WORLD) { outside++; continue; }
    if (occ.collides(p)) { overlapped++; continue; }
    occ.claim(p);
    placements.push(p);
  }
  log(`buildings: ${placements.length} placed, ${overlapped} dropped for overlap, ${tooSmall} too small, ${outside} off-canvas`);

  // --- the built-up and footprint masks
  const builtCells = new Set();
  for (const p of placements) {
    const cx = Math.floor((p.x + p.w / 2) / 24);
    const cy = Math.floor((p.y + p.h / 2) / 24);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) builtCells.add((cx + dx) * 100000 + (cy + dy));
  }
  const builtUp = (x, y) => builtCells.has(Math.floor(x / 24) * 100000 + Math.floor(y / 24));

  const footBuckets = new Map();
  for (const p of placements) {
    for (let gx = Math.floor(p.x / 32); gx <= Math.floor((p.x + p.w - 1) / 32); gx++)
      for (let gy = Math.floor(p.y / 32); gy <= Math.floor((p.y + p.h - 1) / 32); gy++) {
        const k = gx * 100000 + gy;
        if (!footBuckets.has(k)) footBuckets.set(k, []);
        footBuckets.get(k).push(p);
      }
  }
  const occupied = (x, y) => {
    const list = footBuckets.get(Math.floor(x / 32) * 100000 + Math.floor(y / 32));
    if (!list) return false;
    for (const p of list) if (x >= p.x && y >= p.y && x < p.x + p.w && y < p.y + p.h) return true;
    return false;
  };

  // --- roads, in the three passes the mod uses
  const canvas = new Canvas();
  const stats = { surface: 0, pavement: 0, kerb: 0, pavementOverRoad: 0, kerbOnRoad: 0 };

  for (const r of roads) {
    if (!HAS_ART.has(r.cls)) continue;
    forEachInBand(r, r.width / 2, (x, y) => {
      if (occupied(x, y)) return;
      canvas.set(x, y, 'Floor', surfaceFor(r.cls));
      stats.surface++;
    });
  }
  for (const r of roads) {
    if (!SIDEWALK_CLASSES.has(r.cls)) continue;
    const half = r.width / 2;
    forEachInBand(r, half + PAVEMENT_BAND, (x, y, dist, sx, sy) => {
      if (dist <= half) return;
      if (occupied(x, y) || !builtUp(x, y)) return;
      const existing = canvas.get(x, y, 'Floor');
      if (existing) {
        if (existing !== PAVEMENT) stats.pavementOverRoad++;
        return;
      }
      canvas.set(x, y, 'Floor', PAVEMENT);
      stats.pavement++;
      if (dist <= half + KERB_BAND) {
        canvas.set(x, y, 'FloorFurniture', kerbFor(sx, sy));
        stats.kerb++;
      }
    });
  }
  log(`road squares: ${stats.surface} carriageway, ${stats.pavement} pavement, ${stats.kerb} kerb`);
  log(`  pavement squares refused because a carriageway already owned them: ${stats.pavementOverRoad}`);
  log(`  kerbs refused for the same reason: ${stats.kerbOnRoad}`);
  log(`canvas: ${canvas.count} squares in ${canvas.order.length} patches`);

  return { canvas, placements, roads, bearing, stats };
}

// ----------------------------------------------------------------- assertions

/**
 * Boxes that overlap at all. Overlap on its own is not a fault — see
 * {@link checkNothingHidden} for the invariant that actually matters — but it
 * is worth knowing how much of it there is.
 */
export function checkDisjoint(boxes, log = console.log) {
  const buckets = new Map();
  const CELL = 64;
  let overlaps = 0;
  let worst = null;

  for (const b of boxes) {
    const seen = new Set();
    for (let gx = Math.floor(b.x / CELL); gx <= Math.floor((b.x + b.w - 1) / CELL); gx++)
      for (let gy = Math.floor(b.y / CELL); gy <= Math.floor((b.y + b.h - 1) / CELL); gy++) {
        const k = gx * 100000 + gy;
        for (const o of buckets.get(k) || []) {
          if (seen.has(o)) continue;
          seen.add(o);
          const ox = Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x);
          const oy = Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y);
          if (ox > 0 && oy > 0) {
            overlaps++;
            if (!worst || ox * oy > worst.area) worst = { area: ox * oy, a: b, b: o };
          }
        }
      }
    for (let gx = Math.floor(b.x / CELL); gx <= Math.floor((b.x + b.w - 1) / CELL); gx++)
      for (let gy = Math.floor(b.y / CELL); gy <= Math.floor((b.y + b.h - 1) / CELL); gy++) {
        const k = gx * 100000 + gy;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(b);
      }
  }

  if (overlaps === 0) log(`module overlap: none across ${boxes.length} modules`);
  else log(`module overlap: ${overlaps} overlapping pairs, worst ${worst.area} squares`);
  return overlaps;
}

/**
 * The invariant that actually decides whether the world renders correctly.
 *
 * `WorldGenChunk.genRandomSquare` collects every static module whose box
 * contains the square and then uses `get(0)`. So a module may be overlapped
 * freely — what it may never be is overlapped *by an earlier module on a square
 * where it has a tile to draw*, because that tile is then discarded and, if the
 * winner's own `Floor` entry is 0, replaced with bare biome ground.
 *
 * Building boxes are emitted first and roads refuse to paint inside them, so
 * every road tile should fall outside every building box. Anything else is the
 * shredded-building bug coming back.
 */
export function checkNothingHidden(canvas, placements, log = console.log) {
  const buckets = new Map();
  for (const p of placements) {
    for (let gx = Math.floor(p.x / 64); gx <= Math.floor((p.x + p.w - 1) / 64); gx++)
      for (let gy = Math.floor(p.y / 64); gy <= Math.floor((p.y + p.h - 1) / 64); gy++) {
        const k = gx * 100000 + gy;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(p);
      }
  }
  const insideBuilding = (x, y) => {
    for (const p of buckets.get(Math.floor(x / 64) * 100000 + Math.floor(y / 64)) || [])
      if (x >= p.x && y >= p.y && x < p.x + p.w && y < p.y + p.h) return true;
    return false;
  };

  let hidden = 0;
  let tiles = 0;
  for (const k of canvas.order) {
    const patch = canvas.patches.get(k);
    for (const grid of patch.layers.values()) {
      for (const slot of grid.keys()) {
        const x = patch.ox + (slot % PATCH);
        const y = patch.oy + Math.floor(slot / PATCH);
        tiles++;
        if (insideBuilding(x, y)) hidden++;
      }
    }
  }

  if (hidden === 0) log(`nothing hidden: 0 of ${tiles} road tiles fall inside a building module`);
  else log(`NOTHING-HIDDEN FAILED: ${hidden} of ${tiles} road tiles are inside a building module`);
  return hidden;
}

// ------------------------------------------------------- land cover (Ground.lua)

/** Only these pixels resolve to a name that exists in `worldgen.biomes`. */
const BIOME_FOR_PIXEL = {
  0: 'water', 64: 'grass_plain', 115: 'grass_plain', 128: 'flower_plain',
  141: 'grass_plain', 204: 'light_oak_forest', 217: 'light_birch_forest',
  254: 'grass_plain', 255: 'pine_forest',
};
const BIOME_DEFAULT = 96;

/** Transcription of Ground.fillPolygon: block-resolution scanline. */
function fillPolygon(blocks, pts, pixel) {
  if (pts.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  minY = Math.max(0, minY);
  maxY = Math.min(WORLD - 1, maxY);
  if (minY > maxY) return;

  for (let by = Math.floor(minY / BLOCK); by <= Math.floor(maxY / BLOCK); by++) {
    const y = by * BLOCK + BLOCK * 0.5;
    const xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi === yj) continue;
      if (y >= Math.min(yi, yj) && y < Math.max(yi, yj)) xs.push(xj + ((y - yj) / (yi - yj)) * (xi - xj));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x1 = Math.max(0, xs[k]);
      const x2 = Math.min(WORLD - 1, xs[k + 1]);
      if (x2 < x1) continue;
      for (let bx = Math.floor(x1 / BLOCK); bx <= Math.floor(x2 / BLOCK); bx++) blocks.set(bx * 65536 + by, pixel);
    }
  }
}

/**
 * Transcription of Ground.builtBlocks + Ground.toModules.
 *
 * The module count is the number worth watching: `genRandomSquare` scans the
 * whole `static_modules` list once per square, so every module is paid for on
 * every square of every chunk the game ever generates.
 */
export function biomeModules({ canvas, placements }, ground, log = console.log) {
  const blocks = new Map();
  for (const g of ground) fillPolygon(blocks, g.pts, g.pixel);

  const excluded = new Set();
  for (const k of canvas.order) {
    const p = canvas.patches.get(k);
    if (!p.layers.size) continue;
    for (let by = Math.floor(p.minY / BLOCK); by <= Math.floor(p.maxY / BLOCK); by++)
      for (let bx = Math.floor(p.minX / BLOCK); bx <= Math.floor(p.maxX / BLOCK); bx++)
        excluded.add(bx * 65536 + by);
  }
  for (const p of placements) {
    for (let by = Math.floor(p.y / BLOCK); by <= Math.floor((p.y + p.h - 1) / BLOCK); by++)
      for (let bx = Math.floor(p.x / BLOCK); bx <= Math.floor((p.x + p.w - 1) / BLOCK); bx++)
        excluded.add(bx * 65536 + by);
  }

  const rows = new Map();
  for (const [k, pixel] of blocks) {
    if (pixel === BIOME_DEFAULT || excluded.has(k) || !BIOME_FOR_PIXEL[pixel]) continue;
    const by = k % 65536;
    const bx = (k - by) / 65536;
    if (!rows.has(by)) rows.set(by, new Map());
    rows.get(by).set(bx, pixel);
  }

  const runs = [];
  const open = new Map();
  let rowRuns = 0;

  for (const [by, row] of [...rows].sort((a, b) => a[0] - b[0])) {
    const xs = [...row.keys()].sort((a, b) => a - b);
    const seen = new Set();
    let i = 0;
    while (i < xs.length) {
      const bx0 = xs[i];
      const pixel = row.get(bx0);
      let bx1 = bx0;
      while (i + 1 < xs.length && xs[i + 1] === bx1 + 1 && row.get(xs[i + 1]) === pixel) bx1 = xs[++i];
      i++;
      rowRuns++;

      const key = `${bx0}:${bx1}:${pixel}`;
      seen.add(key);
      const run = open.get(key);
      if (run && run.endBy === by - 1) run.endBy = by;
      else {
        const fresh = { bx0, bx1, by0: by, endBy: by, pixel };
        open.set(key, fresh);
        runs.push(fresh);
      }
    }
    for (const [key, run] of open) if (!seen.has(key) && run.endBy < by) open.delete(key);
  }

  // The merge must not change which blocks are covered, and must not make two
  // modules fight for one block.
  const covered = new Map();
  for (const r of runs) {
    for (let by = r.by0; by <= r.endBy; by++)
      for (let bx = r.bx0; bx <= r.bx1; bx++) {
        const k = bx * 65536 + by;
        if (covered.has(k)) log(`  MERGE BUG: block ${bx},${by} claimed twice`);
        covered.set(k, r.pixel);
      }
  }
  let missing = 0;
  let wrong = 0;
  for (const [k, pixel] of blocks) {
    if (pixel === BIOME_DEFAULT || excluded.has(k) || !BIOME_FOR_PIXEL[pixel]) continue;
    if (!covered.has(k)) missing++;
    else if (covered.get(k) !== pixel) wrong++;
  }
  if (missing || wrong) log(`  MERGE BUG: ${missing} blocks lost, ${wrong} blocks changed value`);

  log(
    `land cover: ${blocks.size} blocks painted, ${excluded.size} owned by a prefab, ` +
      `${rowRuns} row runs merged to ${runs.length} biome modules`,
  );
  return runs.length;
}

// ------------------------------------------------------- the map (WorldMap.lua)

const BUILDING_MAP_CLASS = {
  house: 'Residential', apartment: 'Residential',
  retail: 'RetailAndCommercial', grocery: 'RetailAndCommercial',
  office: 'RetailAndCommercial', gas_station: 'RetailAndCommercial',
  restaurant: 'RestaurantsAndEntertainment', bar: 'RestaurantsAndEntertainment',
  medical: 'Medical',
  civic: 'CommunityServices', education: 'CommunityServices',
  church: 'CommunityServices', police: 'CommunityServices', fire: 'CommunityServices',
  industrial: 'Industrial', warehouse: 'Industrial', garage: 'Industrial',
  farm: 'Industrial', shed: 'Industrial',
};
const HIGHWAY_MAP_CLASS = {
  motorway: 'primary', trunk: 'primary', primary: 'primary',
  secondary: 'secondary', residential: 'tertiary', service: 'tertiary',
  cycleway: 'trail', footway: 'trail', track: 'trail',
};
const MAP_WIDTH = { primary: 10, secondary: 8, tertiary: 6, trail: 3 };
const MAX_SEGMENT = 96;
const SIMPLIFY_TOLERANCE = 2.0;

/** Transcription of WorldMap.simplify. */
export function simplify(pts, tol, maxLen) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  let [ax, ay] = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const dev = len < 1e-6 ? Math.hypot(x - ax, y - ay) : Math.abs((x - ax) * dy - (y - ay) * dx) / len;
    if (dev > tol || Math.hypot(x - ax, y - ay) > maxLen) {
      out.push([x, y]);
      ax = x;
      ay = y;
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Transcription of PZWorld/WorldMap.lua, so the file can be checked offline. */
export function buildWorldMap({ placements, roads }, log = console.log) {
  const cells = new Map();
  const order = [];
  let features = 0;
  let strayed = 0;

  function addPolygon(pts, name, value) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    const cx = Math.floor(sx / pts.length / CELL_SIZE);
    const cy = Math.floor(sy / pts.length / CELL_SIZE);
    if (cx < 0 || cy < 0 || cx >= CANVAS_CELLS || cy >= CANVAS_CELLS) return;

    const k = cx * 1000 + cy;
    let buf = cells.get(k);
    if (!buf) { cells.set(k, (buf = { cx, cy, parts: [] })); order.push(k); }

    const ox = cx * CELL_SIZE;
    const oy = cy * CELL_SIZE;
    const points = pts.map(([x, y]) => [Math.floor(x - ox + 0.5), Math.floor(y - oy + 0.5)]);
    for (const [px, py] of points) {
      // Features are stored per cell, so one that reaches far outside its own
      // cell would only be drawn when the wrong cell is on screen.
      if (px < -CELL_SIZE || py < -CELL_SIZE || px > 2 * CELL_SIZE || py > 2 * CELL_SIZE) strayed++;
    }
    buf.parts.push(
      '  <feature>\r\n   <geometry type="Polygon">\r\n    <coordinates>\r\n' +
        points.map(([px, py]) => `     <point x="${px}" y="${py}"/>\r\n`).join('') +
        '    </coordinates>\r\n   </geometry>\r\n   <properties>\r\n' +
        `    <property name="${name}" value="${value}"/>\r\n   </properties>\r\n  </feature>\r\n`,
    );
    features++;
  }

  for (const p of placements) {
    const cls = BUILDING_MAP_CLASS[p.cls] || 'yes';
    addPolygon([[p.x, p.y], [p.x + p.w, p.y], [p.x + p.w, p.y + p.h], [p.x, p.y + p.h]], 'building', cls);
  }

  for (const r of roads) {
    const cls = HIGHWAY_MAP_CLASS[r.cls];
    if (!cls) continue;
    const half = (MAP_WIDTH[cls] || 4) / 2;
    const pts = simplify(r.pts, SIMPLIFY_TOLERANCE, MAX_SEGMENT);
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1];
      const [bx, by] = pts[k];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const pieces = Math.ceil(len / MAX_SEGMENT);
      const nx = (-dy / len) * half;
      const ny = (dx / len) * half;
      for (let j = 1; j <= pieces; j++) {
        const t0 = (j - 1) / pieces;
        const t1 = j / pieces;
        const x0 = ax + dx * t0;
        const y0 = ay + dy * t0;
        const x1 = ax + dx * t1;
        const y1 = ay + dy * t1;
        addPolygon([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], 'highway', cls);
      }
    }
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\r\n<world version="1.0">\r\n';
  for (const k of order) {
    const buf = cells.get(k);
    xml += ` <cell x="${buf.cx}" y="${buf.cy}">\r\n${buf.parts.join('')} </cell>\r\n`;
  }
  xml += '</world>\r\n';

  log(`map: ${features} features across ${order.length} cells, ${(xml.length / 1e6).toFixed(2)} MB`);
  if (strayed) log(`map: WARNING ${strayed} points sit more than a cell outside their own cell`);
  return xml;
}

function defaultPayload() {
  return path.join(os.homedir(), 'Zomboid', 'Lua', 'pzworld_data.txt');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] || defaultPayload();
  if (!fs.existsSync(file)) {
    console.error(`no payload at ${file}`);
    console.error('Run a build once so the helper leaves one, or pass a path.');
    process.exit(1);
  }
  console.log(`replaying ${file}\n`);
  const payload = readPayload(file);
  const result = simulate(payload);

  const patchBoxes = result.canvas.patchBoxes();
  const buildingBoxes = result.placements.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }));
  console.log('');
  console.log(`modules: ${buildingBoxes.length} buildings + ${patchBoxes.length} road patches`);

  // Buildings first, then patches, exactly as stepEmitting orders them.
  checkDisjoint([...buildingBoxes, ...patchBoxes]);
  const bad = checkNothingHidden(result.canvas, result.placements);

  let lost = 0;
  let totalArea = 0;
  const patchIndex = new Map();
  for (const p of patchBoxes) {
    for (let gx = Math.floor(p.x / PATCH); gx <= Math.floor((p.x + p.w - 1) / PATCH); gx++)
      for (let gy = Math.floor(p.y / PATCH); gy <= Math.floor((p.y + p.h - 1) / PATCH); gy++) {
        const k = gx * 100000 + gy;
        if (!patchIndex.has(k)) patchIndex.set(k, []);
        patchIndex.get(k).push(p);
      }
  }
  for (const b of buildingBoxes) {
    totalArea += b.w * b.h;
    const seen = new Set();
    for (let gx = Math.floor(b.x / PATCH); gx <= Math.floor((b.x + b.w - 1) / PATCH); gx++)
      for (let gy = Math.floor(b.y / PATCH); gy <= Math.floor((b.y + b.h - 1) / PATCH); gy++) {
        for (const p of patchIndex.get(gx * 100000 + gy) || []) {
          if (seen.has(p)) continue;
          seen.add(p);
          const ox = Math.min(b.x + b.w, p.x + p.w) - Math.max(b.x, p.x);
          const oy = Math.min(b.y + b.h, p.y + p.h) - Math.max(b.y, p.y);
          if (ox > 0 && oy > 0) lost += ox * oy;
        }
      }
  }
  console.log(
    `building squares inside a road-patch box: ${lost} of ${totalArea} ` +
      `(${((100 * lost) / Math.max(1, totalArea)).toFixed(1)}%) — harmless now that buildings are emitted first`,
  );

  console.log('');
  const biomes = biomeModules(result, payload.ground);
  console.log(
    `total static modules: ${buildingBoxes.length + patchBoxes.length + biomes} ` +
      `(every one is scanned for every square the game generates)`,
  );

  console.log('');
  const xml = buildWorldMap(result);
  const out = process.env.PZW_MAP_OUT;
  if (out) {
    fs.writeFileSync(out, xml, 'utf8');
    console.log(`wrote ${out}`);
  }

  process.exit(bad > 0 ? 1 : 0);
}
