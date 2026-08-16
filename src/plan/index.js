/**
 * The planner: from normalised OSM features to a PlacementPlan.
 *
 * The plan is the intermediate both emitters consume — the worldgen route that
 * ships today and the binary lotpack route that will ship later. Keeping it as
 * a plain data structure rather than letting the emitter reach back into OSM is
 * what makes the second emitter a matter of writing files rather than
 * re-deriving the city.
 *
 * Order matters and is not arbitrary:
 *
 *   1. **Buildings**, because everything else depends on knowing where the town
 *      is. A sidewalk is drawn where there are houses, not where a landuse
 *      polygon claims there ought to be.
 *   2. **Roads**, gated on that built-up mask.
 *   3. **Ground**, painted last so that roads and footprints can stamp `dirt`
 *      over whatever land cover said, and worldgen does not grow a tree through
 *      a kitchen.
 */

import { Projection, bboxAround } from '../geo/project.js';
import { dominantBearing, gridAlignment } from '../geo/orient.js';
import { TileCanvas } from './grid.js';
import { classifyRoad, paintRoad, loadRoadProfile } from './roads.js';
import { placeBuildings, Library } from './buildings.js';
import { paintGround, builtUpMask } from './zones.js';

/**
 * @param {{buildings: object[], roads: object[], ground: object[]}} features raw lon/lat
 * @param {{lat: number, lon: number, radiusM: number,
 *          bbox: {south,west,north,east}, seed: string|number, name: string,
 *          metresPerTile?: number, bearing?: number,
 *          library: Library, catalogue: object, log?: Function}} opts
 */
export function buildPlan(features, opts) {
  const log = opts.log ?? (() => {});
  const metresPerTile = opts.metresPerTile ?? 1;
  const bbox = opts.bbox ?? bboxAround(opts.lat, opts.lon, opts.radiusM);

  // ---- 1. Decide which way the city faces -------------------------------
  const flat = new Projection({ lat: opts.lat, lon: opts.lon, metresPerTile, bearing: 0 });
  const roadsForBearing = features.roads
    .filter((r) => classifyRoad(r))
    .map((r) => ({ points: r.points.map(([lon, lat]) => flat.toLocalMetres(lon, lat)) }));

  const bearing = opts.bearing ?? dominantBearing(roadsForBearing);
  const before = gridAlignment(roadsForBearing, 0);
  const after = gridAlignment(roadsForBearing, bearing);
  log(
    `world bearing ${bearing.toFixed(2)}° — road alignment to the grid ` +
      `${(100 * before).toFixed(1)}% → ${(100 * after).toFixed(1)}%`,
  );

  // ---- 2. Project everything into world squares -------------------------
  // The extent comes from the **requested area**, never from the features.
  //
  // Overpass `out geom` returns a way's whole geometry whenever any part of it
  // falls in the bounding box, so one river or one interstate that merely
  // clips the corner drags the world out by tens of thousands of squares. A
  // 900 m request once produced a 9,431 × 28,327 world and 4,256 cells, almost
  // all of them empty forest.
  const probe = new Projection({ lat: opts.lat, lon: opts.lon, metresPerTile, bearing });
  const pad = 64;
  const area = projectedBbox(probe, bbox);
  const proj = probe.with({
    originTileX: Math.round(-area.minX + pad),
    originTileY: Math.round(-area.minY + pad),
  });

  const bounds = {
    minX: 0,
    minY: 0,
    maxX: Math.round(area.maxX - area.minX) + 2 * pad,
    maxY: Math.round(area.maxY - area.minY) + 2 * pad,
  };

  const toSquares = (pts) => pts.map(([lon, lat]) => proj.toTile(lon, lat));
  const keep = (pts) => intersectsBounds(pts, bounds);
  const projected = {
    buildings: features.buildings
      .map((b) => ({ ...b, points: toSquares(b.points) }))
      .filter((b) => keep(b.points)),
    // A road is clipped rather than dropped: an interstate crossing the map
    // should still be drawn across it, just not for the other forty miles.
    roads: features.roads
      .flatMap((r) => clipPolyline(toSquares(r.points), bounds).map((points) => ({ ...r, points }))),
    ground: features.ground
      .map((g) => ({ ...g, points: toSquares(g.points) }))
      .filter((g) => keep(g.points)),
  };

  const dropped = {
    buildings: features.buildings.length - projected.buildings.length,
    ground: features.ground.length - projected.ground.length,
  };
  if (dropped.buildings || dropped.ground) {
    log(
      `clipped to the requested area: dropped ${dropped.buildings} buildings and ` +
        `${dropped.ground} land-cover polygons that lay outside it`,
    );
  }
  log(
    `world extent ${bounds.maxX - bounds.minX} × ${bounds.maxY - bounds.minY} squares, ` +
      `cells ${Math.floor(bounds.minX / 256)}..${Math.floor(bounds.maxX / 256)} × ` +
      `${Math.floor(bounds.minY / 256)}..${Math.floor(bounds.maxY / 256)}`,
  );

  // ---- 3. Buildings -----------------------------------------------------
  const { placements: allPlacements, stats: buildingStats } = placeBuildings(
    projected.buildings,
    opts.library,
    opts.catalogue,
    { seed: opts.seed, log },
  );

  // A prototype is centred on its footprint, so one near the boundary can hang
  // past it. Project Zomboid indexes cells from zero, so a placement at a
  // negative coordinate has nowhere to live.
  const placements = allPlacements.filter(
    (p) => p.x >= bounds.minX && p.y >= bounds.minY && p.x + p.w <= bounds.maxX && p.y + p.h <= bounds.maxY,
  );
  if (placements.length !== allPlacements.length) {
    log(`dropped ${allPlacements.length - placements.length} buildings hanging off the map edge`);
    buildingStats.placed = placements.length;
  }

  // ---- 4. Roads ---------------------------------------------------------
  const profile = loadRoadProfile();
  const canvas = new TileCanvas();
  const builtUp = builtUpMask(placements);
  const inWorld = (x, y) =>
    x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
  let roadSquares = 0;
  let roadCount = 0;
  for (const road of projected.roads) {
    const spec = classifyRoad(road, profile);
    if (!spec) continue;
    roadSquares += paintRoad(canvas, road, spec, { builtUp, inWorld }, profile);
    roadCount++;
  }
  log(`painted ${roadCount} roads over ${canvas.size} squares (${roadSquares} tile writes)`);

  // ---- 5. Ground --------------------------------------------------------
  const ground = paintGround(projected, canvas, placements, { bounds, log });

  const residuals = buildingStats.residuals;
  return {
    meta: {
      name: opts.name,
      lat: opts.lat,
      lon: opts.lon,
      radiusM: opts.radiusM,
      seed: opts.seed,
      bearing,
      metresPerTile,
      originTileX: proj.originTileX,
      originTileY: proj.originTileY,
      bounds,
      alignment: { before, after },
    },
    projection: proj,
    placements,
    roads: canvas,
    ground,
    stats: {
      buildings: buildingStats,
      roads: { ways: roadCount, squares: canvas.size },
      residual: {
        median: residuals.length ? residuals[residuals.length >> 1] : 0,
        p90: residuals.length ? residuals[Math.floor(residuals.length * 0.9)] : 0,
        max: residuals.length ? residuals[residuals.length - 1] : 0,
      },
    },
  };
}

/**
 * The requested bounding box, in unshifted tile coordinates.
 *
 * All four corners are projected because the world is rotated: a rotated
 * rectangle's extent is not given by two opposite corners.
 */
function projectedBbox(proj, bbox) {
  const corners = [
    [bbox.west, bbox.south],
    [bbox.east, bbox.south],
    [bbox.east, bbox.north],
    [bbox.west, bbox.north],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lon, lat] of corners) {
    const [x, y] = proj.toTile(lon, lat);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Does any part of this geometry's bounding box overlap the world? */
export function intersectsBounds(points, b) {
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
  return maxX >= b.minX && minX <= b.maxX && maxY >= b.minY && minY <= b.maxY;
}

/**
 * Split a polyline into the runs that lie inside the world, keeping one vertex
 * of slack on each side so a road still reaches the edge of the map rather than
 * stopping short of it.
 */
export function clipPolyline(points, b) {
  const inside = (p) => p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY;
  const runs = [];
  let cur = null;

  for (let i = 0; i < points.length; i++) {
    const here = inside(points[i]);
    const prevIn = i > 0 && inside(points[i - 1]);
    const nextIn = i + 1 < points.length && inside(points[i + 1]);

    if (here || prevIn || nextIn) {
      if (!cur) runs.push((cur = []));
      cur.push(points[i]);
    } else {
      cur = null;
    }
  }
  return runs.filter((r) => r.length >= 2);
}

export { bboxAround, Library };
