/**
 * `objects.lua` — the map's zones, and the only way a car ever appears.
 *
 * Project Zomboid does not scatter vehicles. Every one of them comes from a **ParkingStall
 * zone**, registered from this file: `metazoneHandler.doMapZones` walks each directory in
 * `getLotDirectories()`, reloads its `objects.lua`, and hands anything it does not
 * recognise to `registerVehiclesZone` at `OnLoadMapZones`. A map with no `objects.lua`, or
 * one holding an empty table, has no cars anywhere — which is exactly what the generated
 * world had.
 *
 * ## The shape of a stall, measured
 *
 * Muldraugh declares 9,693 of them and they are overwhelmingly one size:
 *
 *     5x3   3,617      3x5   3,420      3x4   155      18x5  131      5x18  108
 *
 * So a stall is one car: three squares across and five along, laid the way the car faces.
 * The long runs (5x18, 5x24) are traffic jams on a highway, named `trafficjam<dir>`; the
 * plain ones carry an empty name and take the default vehicle table.
 *
 * ## Where they go here, and what that is worth
 *
 * Two sources, both derived from things the generator already knows:
 *
 *   - **Car parks.** An `amenity=parking` polygon is real, mapped, and already paved by
 *     the surface pass. It is tiled with stalls. This is the honest half.
 *   - **Kerbside.** One stall every `KERB_SPACING` squares along a built-up street,
 *     alternating sides. This is a guess and is stated as one in `docs/LIMITATIONS.md`:
 *     vanilla's stalls were placed by hand where a car would actually be — a driveway, a
 *     shop front, a junction — and nothing here can tell a driveway from a verge.
 *
 * Every candidate is checked square by square against the surface grid and the building
 * footprints, so a stall never lands on grass, in a wall, or inside somebody's kitchen.
 */

import fs from 'node:fs';

/** A car: three squares across, five along. The dominant vanilla stall. */
export const STALL_SHORT = 3;
export const STALL_LONG = 5;

/**
 * Squares between kerbside stalls.
 *
 * Measured, not guessed: across Muldraugh's 9,693 `ParkingStall` zones the mean distance
 * from a stall to its nearest neighbour is **12.5 squares**. This was 44, which is three
 * and a half times too sparse and is why a generated city had almost no cars in it.
 */
export const KERB_SPACING = 12;

/** Surfaces a car may stand on. */
const PAVED = new Set(['road', 'gravel', 'pavement']);

/** Road classes that get kerbside parking. A slip road through a wood does not. */
const KERBSIDE_CLASSES = new Set(['residential', 'tertiary', 'secondary', 'unclassified', 'service']);

/**
 * A test for "may a car stand on this square", from the surfaces and the footprints.
 *
 * @param {import('./world.js').SurfaceGrid} surfaces
 * @param {{x: number, y: number, w: number, h: number}[]} placements
 */
export function freeSquareTest(surfaces, placements) {
  // Buildings are bucketed rather than scanned: a city has five thousand of them and
  // this question is asked a few hundred thousand times.
  const BUCKET = 64;
  const buckets = new Map();
  for (const p of placements) {
    for (let gx = Math.floor(p.x / BUCKET); gx <= Math.floor((p.x + p.w - 1) / BUCKET); gx++) {
      for (let gy = Math.floor(p.y / BUCKET); gy <= Math.floor((p.y + p.h - 1) / BUCKET); gy++) {
        const key = `${gx},${gy}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(p);
      }
    }
  }
  return (x, y) => {
    if (!PAVED.has(surfaces.get(x, y))) return false;
    for (const p of buckets.get(`${Math.floor(x / BUCKET)},${Math.floor(y / BUCKET)}`) ?? []) {
      if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) return false;
    }
    return true;
  };
}

/** Is every square of this rectangle free? */
function rectFree(free, x, y, w, h) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) if (!free(x + dx, y + dy)) return false;
  }
  return true;
}

/**
 * Tile a car park with stalls.
 *
 * Rows run along the polygon's longer axis, which is how a real lot is laid out and how
 * vanilla's are: a wide lot gets cars nose-in along its width.
 */
export function stallsInArea(points, free, { max = 60 } = {}) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return [];

  const wide = maxX - minX >= maxY - minY;
  const w = wide ? STALL_SHORT : STALL_LONG;
  const h = wide ? STALL_LONG : STALL_SHORT;

  const out = [];
  for (let y = Math.ceil(minY); y + h <= maxY && out.length < max; y += h) {
    for (let x = Math.ceil(minX); x + w <= maxX && out.length < max; x += w) {
      if (rectFree(free, x, y, w, h)) out.push({ name: '', type: 'ParkingStall', x, y, z: 0, width: w, height: h });
    }
  }
  return out;
}

/**
 * One stall every `spacing` squares along a street, alternating sides.
 *
 * The offset is taken from the road's own width so the car sits against the kerb rather
 * than in the middle of the carriageway, and the stall is turned to match the direction
 * of travel — a car parked across a street is worse than no car.
 */
export function stallsAlongRoad(road, free, { spacing = KERB_SPACING } = {}) {
  const pts = road.points ?? [];
  if (pts.length < 2) return [];
  const half = Math.max(1, Math.floor((road.width ?? 6) / 2) - 1);

  const out = [];
  let travelled = 0;
  let side = 1;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;

    for (let t = spacing - travelled; t < len; t += spacing) {
      const px = x0 + (dx * t) / len;
      const py = y0 + (dy * t) / len;
      // Normal, pointing to whichever side this stall is on.
      const nx = (-dy / len) * side;
      const ny = (dx / len) * side;

      // Along the road, not across it.
      const alongX = Math.abs(dx) >= Math.abs(dy);
      const w = alongX ? STALL_LONG : STALL_SHORT;
      const h = alongX ? STALL_SHORT : STALL_LONG;

      const x = Math.round(px + nx * half - w / 2);
      const y = Math.round(py + ny * half - h / 2);
      if (rectFree(free, x, y, w, h)) {
        out.push({ name: '', type: 'ParkingStall', x, y, z: 0, width: w, height: h });
      }
      side = -side;
    }
    travelled = (travelled + len) % spacing;
  }
  return out;
}

/**
 * Every stall for a generated city.
 *
 * @param {object} opts
 * @param {import('./world.js').SurfaceGrid} opts.surfaces
 * @param {object[]} opts.cover  projected land cover; `pixel === 200` is a car park
 * @param {object[]} opts.roads  projected roads, in world squares
 * @param {{x: number, y: number, w: number, h: number}[]} opts.placements
 */
export function planParking({ surfaces, cover = [], roads = [], placements = [], log = () => {} }) {
  const free = freeSquareTest(surfaces, placements);
  const stalls = [];
  let areas = 0;

  for (const area of cover) {
    if (area.pixel !== 200) continue;
    const found = stallsInArea(area.points, free);
    if (found.length) areas++;
    stalls.push(...found);
  }
  const inLots = stalls.length;

  for (const road of roads) {
    if (!KERBSIDE_CLASSES.has(road.cls)) continue;
    stalls.push(...stallsAlongRoad(road, free));
  }

  log(`${stalls.length} parking stalls — ${inLots} in ${areas} car parks, ${stalls.length - inLots} at the kerb`);
  return stalls;
}

/**
 * Serialise to the exact form `reloadLuaFile` expects.
 *
 * `metazoneHandler` does `objects = {}` then reloads this file, so it must assign the
 * global `objects` and nothing else. Coordinates are integers; a float here reaches
 * `registerVehiclesZone(int, int, ...)` and Kahlua truncates it silently.
 */
export function encodeObjectsLua(records) {
  const lines = ['objects = {'];
  for (const r of records) {
    lines.push(
      `  { name = "${r.name ?? ''}", type = "${r.type}", ` +
        `x = ${Math.round(r.x)}, y = ${Math.round(r.y)}, z = ${Math.round(r.z ?? 0)}, ` +
        `width = ${Math.round(r.width)}, height = ${Math.round(r.height)} },`,
    );
  }
  lines.push('}', '');
  return lines.join('\n');
}

export function writeObjects(file, records) {
  fs.writeFileSync(file, encodeObjectsLua(records), 'utf8');
  return records.length;
}
