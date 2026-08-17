/**
 * Generating a world as authored map cells, from coordinates to files.
 *
 * This is the whole pipeline for the route that produces real buildings. It replaces
 * `emit/worldgen.js`, which writes instructions for the game's runtime generator and is
 * bounded by what `PrefabStructure` can express — four tile layers, one storey, no roof.
 *
 * The order is not arbitrary. Buildings are placed before roads are painted so the road
 * bands know what ground is spoken for; ground is laid last so it fills whatever nothing
 * else claimed, which is what keeps every chunk complete at level 0 and stops the game
 * regenerating it procedurally.
 */

import path from 'node:path';

import { Projection, bboxAround } from '../geo/project.js';
import { dominantBearing, gridAlignment } from '../geo/orient.js';
import { classifyRoad } from '../plan/roads.js';
import { classifyFromTags } from '../plan/buildings.js';
import { groundPixelFor } from '../plan/zones.js';
import { buildSurfaces, fillPolygon } from '../plan/surfaces.js';
import { placeAuthored, materialise } from '../plan/place.js';
import { cellSource } from '../extract/building.js';
import { emitWorld } from './world.js';
import { writeStreets } from './streets.js';
import { planParking, writeObjects } from './objects.js';
import { CELL_SIZE } from '../formats/lotheader.js';
import { CANVAS_CELLS } from '../../tools/make-canvas.js';

/**
 * Project every feature into world squares, once the bearing is settled.
 *
 * The extent comes from the **requested area**, never from the features: Overpass
 * returns a way's whole geometry whenever any part of it touches the bounding box, so
 * one river clipping a corner once turned a 900 m request into a 9,431 x 28,327 world.
 */
function projectAll(features, opts) {
  const bbox = opts.bbox ?? bboxAround(opts.lat, opts.lon, opts.radiusM);
  const metresPerTile = opts.metresPerTile ?? 1;

  const flat = new Projection({ lat: opts.lat, lon: opts.lon, metresPerTile, bearing: 0 });
  const forBearing = features.roads
    .filter((r) => classifyRoad(r))
    .map((r) => ({ points: r.points.map(([lon, lat]) => flat.toLocalMetres(lon, lat)) }));

  const bearing = opts.bearing ?? dominantBearing(forBearing);
  const before = gridAlignment(forBearing, 0);
  const after = gridAlignment(forBearing, bearing);

  const probe = new Projection({ lat: opts.lat, lon: opts.lon, metresPerTile, bearing });
  const corners = [
    [bbox.west, bbox.south],
    [bbox.east, bbox.south],
    [bbox.east, bbox.north],
    [bbox.west, bbox.north],
  ].map(([lon, lat]) => probe.toTile(lon, lat));

  const minX = Math.min(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxX = Math.max(...corners.map((c) => c[0]));
  const maxY = Math.max(...corners.map((c) => c[1]));

  // Centre the city in the shipped canvas, so the country wraps it on all four sides
  // rather than lying to the east and south of a town wedged into the corner.
  //
  // Then snap the footprint out to whole cells. A partly covered cell would have chunks
  // that are complete on one side of the boundary and empty on the other, and the empty
  // ones revert to procedural — a visible seam through the middle of a cell rather than
  // at the edge of the map.
  const canvas = opts.canvasSquares ?? CANVAS_CELLS * CELL_SIZE;
  const pad = Math.max(CELL_SIZE, Math.round((canvas - (maxX - minX)) / 2));
  const originX = opts.originX ?? Math.round(-minX + pad);
  const originY = opts.originY ?? Math.round(-minY + pad);
  const proj = probe.with({ originTileX: originX, originTileY: originY });

  const bounds = {
    minX: Math.floor((originX + minX) / CELL_SIZE) * CELL_SIZE,
    minY: Math.floor((originY + minY) / CELL_SIZE) * CELL_SIZE,
    maxX: Math.ceil((originX + maxX + 1) / CELL_SIZE) * CELL_SIZE - 1,
    maxY: Math.ceil((originY + maxY + 1) / CELL_SIZE) * CELL_SIZE - 1,
  };

  const toSquares = (pts) => pts.map(([lon, lat]) => proj.toTile(lon, lat));
  const touches = (pts) => {
    let a = Infinity;
    let b = Infinity;
    let c = -Infinity;
    let d = -Infinity;
    for (const [x, y] of pts) {
      if (x < a) a = x;
      if (y < b) b = y;
      if (x > c) c = x;
      if (y > d) d = y;
    }
    return c >= bounds.minX && a <= bounds.maxX && d >= bounds.minY && b <= bounds.maxY;
  };

  // Classify here, from the tags, rather than expecting the caller to have done it.
  // `normalise()` deliberately keeps the raw tags and decides nothing — leaving this
  // out meant every footprint fell through to the `unknown` fallback chain and became
  // a house, and every land-cover polygon had no pixel and painted nothing. Neither
  // failed; the town was simply 5,014 houses on undifferentiated grass.
  return {
    bearing,
    alignment: { before, after },
    proj,
    bounds,
    buildings: features.buildings
      .map((b) => {
        const points = toSquares(b.points);
        return { ...b, points, cls: b.cls ?? classifyFromTags(b.tags, polygonArea(points)) };
      })
      .filter((b) => touches(b.points)),
    roads: features.roads
      .map((r) => {
        const spec = classifyRoad(r);
        return {
          ...r,
          points: toSquares(r.points),
          cls: r.cls ?? spec?.cls ?? null,
          // Carried so the parking planner can tuck a car against the kerb rather
          // than guess at a carriageway width.
          width: r.width ?? spec?.width ?? null,
        };
      })
      .filter((r) => r.cls && touches(r.points)),
    ground: features.ground
      .map((g) => ({ ...g, points: toSquares(g.points), pixel: g.pixel ?? groundPixelFor(g.tags) }))
      .filter((g) => g.pixel !== null && touches(g.points)),
  };
}

/**
 * @param {{buildings: object[], roads: object[], ground: object[]}} features raw lon/lat
 * @param {object} opts
 * @param {string} opts.mapDir  where the cells go
 * @param {import('../extract/building.js').BuildingRef[]} opts.library
 * @param {import('../formats/tiledefs.js').TileCatalogue} opts.catalogue
 */
export function generateWorld(features, opts) {
  const log = opts.log ?? (() => {});
  const onProgress = opts.onProgress ?? (() => {});
  onProgress({ stage: 'placing', progress: 0.12, message: 'Working out which way the city faces' });
  const projected = projectAll(features, opts);

  log(
    `world bearing ${projected.bearing.toFixed(2)}째 — streets on the grid ` +
      `${(100 * projected.alignment.before).toFixed(0)}% to ${(100 * projected.alignment.after).toFixed(0)}%`,
  );
  const b = projected.bounds;
  log(
    `footprint ${b.maxX - b.minX + 1} x ${b.maxY - b.minY + 1} squares, ` +
      `cells ${b.minX / CELL_SIZE}..${(b.maxX + 1) / CELL_SIZE - 1} x ${b.minY / CELL_SIZE}..${(b.maxY + 1) / CELL_SIZE - 1}`,
  );

  // ---- buildings ---------------------------------------------------------
  onProgress({ stage: 'placing', progress: 0.18, message: 'Choosing a real building for every footprint' });
  const source = cellSource(32, opts.catalogue);
  const { placements, stats: placeStats } = placeAuthored(
    projected.buildings,
    opts.library,
    source,
    opts.catalogue,
    { bounds: projected.bounds, seed: opts.seed, log },
  );

  // ---- surfaces ----------------------------------------------------------
  // Built-up is decided by where the buildings actually landed, not by what a
  // land-use polygon claims: a town is where the houses are.
  onProgress({ stage: 'surfaces', progress: 0.25, message: 'Laying roads, pavements and ground' });
  const builtUp = builtUpMask(placements);
  const surfaces = buildSurfaces(
    {
      meta: { bounds: projected.bounds },
      roads: { ways: projected.roads },
      ground: { polygons: projected.ground.map((g) => ({ ...g, area: polygonArea(g.points) })) },
      builtUp,
    },
    { log },
  );

  // Car parks are paved *and* stand where the planner says, so they are painted
  // after the roads rather than with the other land cover.
  for (const g of projected.ground) {
    if (g.pixel === 200) fillPolygon(surfaces, g.points, 'road');
  }

  // ---- read, rotate, write ----------------------------------------------
  log(`reading ${placements.length} buildings from the install`);
  const built = materialise(placements, source, opts.catalogue, {
    log,
    onRead: (read, total) =>
      onProgress({
        stage: 'reading',
        progress: 0.3 + 0.35 * (read / total),
        message: `Reading building ${read} of ${total} out of your install`,
      }),
  });

  const emitted = emitWorld({
    surfaces,
    buildings: built,
    catalogue: opts.catalogue,
    mapDir: opts.mapDir,
    log,
    onProgress,
    builtUp,
    seed: String(opts.seed ?? ''),
  });

  // ---- street names ------------------------------------------------------
  const streets = writeStreets(path.join(opts.mapDir, 'streets.xml'), projected.roads);
  log(`streets.xml: ${streets.written} records for ${streets.named} named streets`);

  // ---- cars --------------------------------------------------------------
  // Vehicles exist only where a ParkingStall zone says so, and zones come from
  // objects.lua. Written after the surfaces are final so no stall lands on grass.
  const stalls = planParking({
    surfaces,
    cover: projected.ground,
    roads: projected.roads,
    placements,
    seed: String(opts.seed ?? ''),
    log,
  });
  writeObjects(path.join(opts.mapDir, 'objects.lua'), stalls);

  return {
    bearing: projected.bearing,
    alignment: projected.alignment,
    bounds: projected.bounds,
    projection: projected.proj,
    placements: built,
    roads: projected.roads,
    cover: projected.ground,
    stats: { ...placeStats, ...emitted, streets: streets.written, stalls: stalls.length },
  };
}

/** A cheap "is this square in town" test, from where the buildings landed. */
export function builtUpMask(placements, radius = 24) {
  const cells = new Set();
  for (const p of placements) {
    const cx = Math.floor((p.x + p.w / 2) / radius);
    const cy = Math.floor((p.y + p.h / 2) / radius);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) cells.add(`${cx + dx},${cy + dy}`);
    }
  }
  return (x, y) => cells.has(`${Math.floor(x / radius)},${Math.floor(y / radius)}`);
}

function polygonArea(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(a) / 2;
}

export { projectAll };
export const paths = { join: path.join };
