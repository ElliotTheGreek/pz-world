/**
 * The in-game map, built from the same plan the cells come from.
 *
 * `src/formats/worldmap.js` has the format and the reason it has to be binary: the
 * game's XML reader passes `WorldMapPoints.setPoints` a count of shorts where the
 * binary reader passes a count of points, so it walks twice as far as it wrote and
 * throws out of every feature. Vanilla never notices because every shipped map has a
 * `.bin` beside it.
 *
 * Only these tags draw anything — `ISMapDefinitions.lua` builds the style from a fixed
 * set of filters and a feature carrying anything else is parsed and then ignored:
 *
 *     natural=forest   water=river   railway=*
 *     highway=primary|secondary|tertiary|trail
 *     building=yes|Residential|CommunityServices|Hospitality|Industrial|
 *              Medical|RestaurantsAndEntertainment|RetailAndCommercial
 *
 * Roads are **polygon** layers, not lines: a road on the map is a quad as wide as the
 * road, not a stroked centreline.
 */

import { CELL_SIZE } from '../formats/lotheader.js';
import { encodeWorldMapBin } from '../formats/worldmap.js';

/** Our building classes to the seven the map style knows how to colour. */
export const BUILDING_CLASS = {
  house: 'Residential',
  apartment: 'Residential',
  retail: 'RetailAndCommercial',
  grocery: 'RetailAndCommercial',
  office: 'RetailAndCommercial',
  gas_station: 'RetailAndCommercial',
  restaurant: 'RestaurantsAndEntertainment',
  bar: 'RestaurantsAndEntertainment',
  medical: 'Medical',
  civic: 'CommunityServices',
  education: 'CommunityServices',
  church: 'CommunityServices',
  police: 'CommunityServices',
  fire: 'CommunityServices',
  industrial: 'Industrial',
  warehouse: 'Industrial',
  garage: 'Industrial',
  farm: 'Industrial',
  shed: 'Industrial',
};

/** Our road classes to the four the map style knows how to colour. */
export const HIGHWAY_CLASS = {
  motorway: 'primary',
  trunk: 'primary',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  residential: 'tertiary',
  service: 'tertiary',
  cycleway: 'trail',
  footway: 'trail',
  track: 'trail',
};

/** Land-cover pixels to the two area layers that exist. */
export const COVER_CLASS = {
  0: ['water', 'river'],
  204: ['natural', 'forest'],
  217: ['natural', 'forest'],
  255: ['natural', 'forest'],
};

/** How wide the map draws a road, by class. */
const MAP_WIDTH = { primary: 10, secondary: 8, tertiary: 6, trail: 3 };

/** Longer than this and a road is cut, so no feature strays far from its own cell. */
const MAX_SEGMENT = 96;
const SIMPLIFY_TOLERANCE = 2.0;

/** Drop vertices that say nothing: OSM puts one every few metres along a curve. */
export function simplify(points, tol = SIMPLIFY_TOLERANCE, maxLen = MAX_SEGMENT) {
  if (points.length <= 2) return points;
  const out = [points[0]];
  let [ax, ay] = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [bx, by] = points[i + 1];
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
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Build the map document.
 *
 * Every feature is assigned to the cell holding its centre and written in that cell's
 * coordinates. They may overrun it — the shipped `challengemaps/Studio` map has a road
 * running from 0 to 300 in a 300-square cell — but not far, because `WorldMapData`
 * stores and culls features per cell.
 */
export function buildWorldMapDoc({ placements = [], roads = [], cover = [], bounds }) {
  const cells = new Map();
  const order = [];
  let features = 0;

  const addPolygon = (points, name, value) => {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of points) {
      sx += x;
      sy += y;
    }
    const cx = Math.floor(sx / points.length / CELL_SIZE);
    const cy = Math.floor(sy / points.length / CELL_SIZE);
    if (cx < 0 || cy < 0) return;

    const key = `${cx},${cy}`;
    let cell = cells.get(key);
    if (!cell) {
      cells.set(key, (cell = { x: cx, y: cy, features: [] }));
      order.push(key);
    }
    const ox = cx * CELL_SIZE;
    const oy = cy * CELL_SIZE;
    const ring = [];
    for (const [x, y] of points) ring.push(Math.round(x - ox), Math.round(y - oy));
    cell.features.push({ type: 'Polygon', rings: [ring], properties: [[name, value]] });
    features++;
  };

  for (const p of placements) {
    const cls = BUILDING_CLASS[p.requestedClass] ?? BUILDING_CLASS[p.cls] ?? 'yes';
    addPolygon([[p.x, p.y], [p.x + p.w, p.y], [p.x + p.w, p.y + p.h], [p.x, p.y + p.h]], 'building', cls);
  }

  for (const road of roads) {
    const cls = HIGHWAY_CLASS[road.cls];
    if (!cls) continue;
    const half = (MAP_WIDTH[cls] ?? 4) / 2;
    const pts = simplify(road.points);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const pieces = Math.ceil(len / MAX_SEGMENT);
      const nx = (-dy / len) * half;
      const ny = (dx / len) * half;
      for (let k = 1; k <= pieces; k++) {
        const t0 = (k - 1) / pieces;
        const t1 = k / pieces;
        const x0 = ax + dx * t0;
        const y0 = ay + dy * t0;
        const x1 = ax + dx * t1;
        const y1 = ay + dy * t1;
        addPolygon(
          [[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]],
          'highway',
          cls,
        );
      }
    }
  }

  // Land cover is drawn from the source polygons rather than the rasterised surface
  // grid: the map is a schematic, and a forest reads better as its own outline than as
  // a staircase of 16-square blocks.
  //
  // **Clipped to the map first.** Overpass returns a way's entire geometry whenever any
  // part of it touches the request, so Lake Champlain arrives as a polygon stretching
  // tens of kilometres past the world. A feature is filed under the cell holding its
  // *centre*, and that lake's centre is nowhere near the map — it stretched the grid
  // from 22 cells to 111 and put the shoreline in a cell no one will ever look at.
  if (bounds) {
    for (const area of cover) {
      const tag = COVER_CLASS[area.pixel];
      if (!tag || area.points.length < 3) continue;
      const clipped = clipToRect(area.points, bounds);
      if (clipped.length < 3) continue;
      addPolygon(simplify(clipped, 4, 256), tag[0], tag[1]);
    }
  }

  // Size the grid from the cells that actually got features, not from the plan's
  // bounds. A feature is filed under the cell holding its *centre*, and a building or
  // a road quad sitting on the last square of the map has a centre that rounds into
  // the next cell along — one cell past the footprint, every time. Deriving the extent
  // here means the encoder never has to reject anything.
  const list = order.map((k) => cells.get(k));
  let width = bounds ? Math.ceil((bounds.maxX + 1) / CELL_SIZE) : 0;
  let height = bounds ? Math.ceil((bounds.maxY + 1) / CELL_SIZE) : 0;
  for (const cell of list) {
    if (cell.x + 1 > width) width = cell.x + 1;
    if (cell.y + 1 > height) height = cell.y + 1;
  }

  return { width, height, originX: 0, originY: 0, cells: list, features };
}

/**
 * Sutherland–Hodgman: clip a polygon to an axis-aligned rectangle.
 *
 * Four half-plane passes, each keeping what is inside and inserting a vertex wherever an
 * edge crosses. Convexity of the *clip* region is what makes it correct; the subject
 * polygon may be any shape, which matters because a lake is not convex.
 */
export function clipToRect(points, rect) {
  const edges = [
    { inside: ([x]) => x >= rect.minX, cut: (a, b) => cutX(a, b, rect.minX) },
    { inside: ([x]) => x <= rect.maxX, cut: (a, b) => cutX(a, b, rect.maxX) },
    { inside: ([, y]) => y >= rect.minY, cut: (a, b) => cutY(a, b, rect.minY) },
    { inside: ([, y]) => y <= rect.maxY, cut: (a, b) => cutY(a, b, rect.maxY) },
  ];

  let out = points;
  for (const edge of edges) {
    if (!out.length) return [];
    const next = [];
    for (let i = 0, j = out.length - 1; i < out.length; j = i++) {
      const cur = out[i];
      const prev = out[j];
      const curIn = edge.inside(cur);
      const prevIn = edge.inside(prev);
      if (curIn) {
        if (!prevIn) next.push(edge.cut(prev, cur));
        next.push(cur);
      } else if (prevIn) {
        next.push(edge.cut(prev, cur));
      }
    }
    out = next;
  }
  return out;
}

const cutX = (a, b, x) => [x, a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1])];
const cutY = (a, b, y) => [a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), y];

export function encodeWorldMap(doc) {
  return encodeWorldMapBin(doc);
}
