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
 * Stepping outward from the centreline an integer number of squares along the unit
 * normal is exact on the two grid axes and a sieve at any other bearing. `forEachInBand`
 * in `./polyline.js` fills the capsule instead: no gaps, no double writes, and the round
 * ends close the notch that used to open on the outside of every corner.
 *
 * ## The road artwork does not come from here
 *
 * This grid answers *what material* a square is, for the blend, biome and vegetation
 * passes. *Which sprite* goes on it is decided by `src/plan/roadworks.js`, which runs the
 * real cross-section renderers. Where a roadworks canvas is supplied, this reads its
 * bands rather than laying a second, cruder approximation of the same roads over them.
 */

import { SurfaceGrid } from '../emit/world.js';
import { capsuleRows, forEachInBand } from './polyline.js';
import { loadSemanticRegistry, resolveSemantic } from '../catalogue/semantic-registry.js';
import { classifyRoad, loadRoadProfile } from './roads.js';
import { BAND_OWNER, LOOSE_ROAD_SURFACES, roadCondition, roadTrafficProxy } from './roadworks.js';
import { FIELD_SIGMA, fieldPercentile, terrainFields } from './terrain-fields.js';
import { roadMaterialAt } from './decay.js';

/**
 * Which material a natural square is made of, and how often.
 *
 * These are measured, not estimated. Sampling every base tile at level 0 across
 * 24 Muldraugh cells — 1,386,631 natural squares — gives the shares vanilla's
 * own countryside uses:
 *
 *     Grass_Dark   66.29%      Dirt_Grass   4.48%
 *     Grass_Medium 20.71%      Dirt         1.12%
 *     Grass_Light   6.97%      Sand         0.44%
 *
 * The four *variants* inside each material are a per-square dither (`baseTile`);
 * these profiles choose between materials, which is the patch structure a player
 * actually sees. Profiles retain that ordering while respecting OSM meaning:
 * farmland never becomes woodland, water never becomes soil, and construction
 * never grows grass.
 */
export const NATURAL_SURFACE_PROFILES = {
  // Unspecified wilderness / primary forest — the measured shares, renormalised
  // over the four materials this generator plants on.
  96: [['grass', 0.673], ['meadow', 0.211], ['grassLight', 0.071], ['dirtGrass', 0.045]],
  255: [['grass', 0.700], ['meadow', 0.200], ['grassLight', 0.060], ['dirtGrass', 0.040]],
  // Open managed grass and town lots are lighter and less scuffed than woodland.
  64: [['meadow', 0.560], ['grassLight', 0.240], ['grass', 0.170], ['dirtGrass', 0.030]],
  115: [['grass', 0.600], ['meadow', 0.240], ['grassLight', 0.090], ['dirtGrass', 0.070]],
  128: [['meadow', 0.560], ['grassLight', 0.250], ['grass', 0.150], ['dirtGrass', 0.040]],
  // Scrub and orchard remain recognisably light and open while gaining broad
  // variation, and scrub shows more bare earth than mown ground does.
  204: [['grassLight', 0.600], ['meadow', 0.250], ['grass', 0.060], ['dirtGrass', 0.090]],
  217: [['grassLight', 0.500], ['grass', 0.250], ['meadow', 0.150], ['dirtGrass', 0.100]],
};

/** Semantics that must remain single-purpose, regardless of noise. */
const FIXED_COVER_SURFACE = {
  0: 'water',
  141: 'grassLight', // farmland ownership is retained for the later crop pass
  200: 'road',       // car parks are paved
  254: 'dirt',       // construction and quarry ground
};

function coverOwner(pixel) {
  if (pixel === 0) return 'water';
  if (pixel === 141 || pixel === 204) return 'farmland';
  if (pixel === 200 || pixel === 254) return 'built';
  if (pixel === 64 || pixel === 115 || pixel === 128) return 'managed';
  return 'natural';
}

/**
 * Pick a material from a cumulative measured profile.
 *
 * The `material` field is deliberately fine — median run of one material along a
 * row is 3 squares and its 90th percentile is 19, which is what Muldraugh
 * measures. A broad regional field then tilts the whole neighbourhood lighter or
 * darker by up to a quarter of the distribution, so a dry hillside and a damp
 * hollow are recognisably different places without either becoming uniform.
 */
export function naturalSurfaceAt(pixel, x, y, fields) {
  const fixed = FIXED_COVER_SURFACE[pixel];
  if (fixed) return fixed;
  const profile = NATURAL_SURFACE_PROFILES[pixel];
  if (!profile) return null;

  // Mixed before the rank rather than after it. Clamping two ranks together
  // piles every overflow into whichever material the profile lists last, which
  // is how the driest material ended up half as common again as it should be.
  const value = fields.at('material', x, y) * (1 - REGIONAL_TILT)
    + fields.at('moisture', x, y) * REGIONAL_TILT;
  const percentile = fieldPercentile(value, MIXED_SIGMA);

  let cumulative = 0;
  for (const [surface, share] of profile) {
    cumulative += share;
    if (percentile <= cumulative) return surface;
  }
  return profile[profile.length - 1][0];
}

/** How far a wet or dry region shifts the local material distribution. */
export const REGIONAL_TILT = 0.15;

/**
 * Standard deviation of the mixture the material choice actually samples.
 *
 * The two fields have independent seeds, so the variances add in proportion to
 * the square of their weights.
 */
const MIXED_SIGMA = Math.hypot(
  (1 - REGIONAL_TILT) * FIELD_SIGMA.material,
  REGIONAL_TILT * FIELD_SIGMA.moisture,
);

/**
 * Decide the surface of every square in the footprint.
 *
 * Later passes overwrite earlier ones, so the order is least to most specific:
 * default ground, then land cover, then car parks, then roads, then pavements.
 *
 * @param {object} plan from src/plan/index.js
 * @param {{default?: string, log?: Function}} [opts]
 */
/** Shared projected OSM vertices are junction anchors for the wear-distance field. */
export function roadJunctions(roads) {
  const uses = new Map();
  for (let ri = 0; ri < roads.length; ri++) {
    const seen = new Set();
    for (const [x, y] of roads[ri].points ?? []) {
      const key = `${Math.round(x)},${Math.round(y)}`;
      if (!seen.has(key)) uses.set(key, (uses.get(key) ?? 0) + 1);
      seen.add(key);
    }
  }
  const out = new Set();
  for (const [key, count] of uses) if (count > 1) out.add(key);
  return out;
}

function junctionDistanceForRoad(road, junctions, x, y) {
  let nearest = 254;
  for (const [jx, jy] of road.points ?? []) {
    if (!junctions.has(`${Math.round(jx)},${Math.round(jy)}`)) continue;
    nearest = Math.min(nearest, Math.hypot(x - jx, y - jy));
  }
  return nearest;
}

/**
 * Apply registry-selected yards, pedestrian hardstand, and vehicle aprons.
 *
 * Every placed footprint is claimed before any surrounding square is painted, so an
 * apron can never enter this building or a neighbour. Roads are painted afterwards and
 * therefore retain priority where a mapped access way crosses the surrounding treatment.
 */
export function applyBuildingSurroundings(
  surfaces,
  buildings = [],
  registry = loadSemanticRegistry(),
) {
  const occupied = new Set();
  for (const building of buildings) {
    for (let y = building.y; y < building.y + building.h; y++) {
      for (let x = building.x; x < building.x + building.w; x++) occupied.add(`${x},${y}`);
    }
  }

  let painted = 0;
  for (const building of buildings) {
    const buildingClass = building.requestedClass ?? building.cls ?? 'unknown';
    const mapping = resolveSemantic(registry, 'building.surroundings', { buildingClass });
    if (!mapping) continue;
    const radius = Math.max(0, Math.round(mapping.radius ?? 0));
    const restricted = ['private', 'no'].includes(building.tags?.access) ||
      building.tags?.motor_vehicle === 'no';
    // Access restrictions remove a vehicle-capable apron; they do not turn private
    // property into public parking. Preserve permeable ground with managed ownership.
    const surface = mapping.vehicleAccess && restricted ? null : mapping.surface;
    const owner = mapping.vehicleAccess && restricted ? 'managed' : (mapping.owner ?? 'managed');

    for (let y = building.y - radius; y < building.y + building.h + radius; y++) {
      for (let x = building.x - radius; x < building.x + building.w + radius; x++) {
        if (!surfaces.inside(x, y) || occupied.has(`${x},${y}`)) continue;
        const existing = surfaces.get(x, y);
        if (!existing) continue;
        // Never replace mapped water. All other site materials may legitimately become
        // the immediate authored grounds of the selected structure.
        if (surfaces.ownerAt(x, y) === 'water') continue;
        surfaces.set(x, y, surface ?? existing, owner);
        painted++;
      }
    }
  }
  return painted;
}

export function buildSurfaces(plan, opts = {}) {
  const log = opts.log ?? (() => {});
  // The first pass alone is every square in the world. On a city that is tens of
  // millions of them and the better part of a minute with nothing to show for
  // it, so it reports by row.
  const onProgress = opts.onProgress ?? (() => {});
  const profile = loadRoadProfile();
  const bounds = plan.meta.bounds;
  const surfaces = new SurfaceGrid(bounds);
  const fields = opts.terrain ?? terrainFields(opts.seed ?? '');

  // Unspecified ground is wilderness, not one city-sized grass tile. An explicit
  // default remains useful to small callers and tests that need a fixed material.
  if (opts.default) {
    surfaces.fill(opts.default, 'natural');
  } else {
    const rows = bounds.maxY - bounds.minY + 1;
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      if ((y - bounds.minY) % 128 === 0) onProgress((y - bounds.minY) / rows);
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        surfaces.set(x, y, naturalSurfaceAt(96, x, y, fields), 'natural');
      }
    }
  }

  // ---- land cover, largest first so a park inside a district wins -------
  const covers = [...plan.ground.polygons ?? []].sort((a, b) => (b.area ?? 0) - (a.area ?? 0));
  let coverSquares = 0;
  for (const cover of covers) {
    const treatment = cover.treatment ?? null;
    const fixedSurface = treatment?.surface ?? FIXED_COVER_SURFACE[cover.pixel];
    if (!fixedSurface && !NATURAL_SURFACE_PROFILES[cover.pixel]) continue;
    const owner = treatment?.owner ?? coverOwner(cover.pixel);
    coverSquares += fillPolygon(
      surfaces,
      cover.points,
      fixedSurface ?? ((x, y) => naturalSurfaceAt(cover.pixel, x, y, fields)),
      owner,
    );
  }
  log(`land cover: ${covers.length} areas over ${coverSquares} squares`);

  // ---- building sites ---------------------------------------------------
  const surroundingSquares = applyBuildingSurroundings(
    surfaces,
    plan.buildings ?? [],
    opts.semanticRegistry ?? loadSemanticRegistry(),
  );
  log(`building surroundings: ${surroundingSquares} squares`);

  // ---- roads ------------------------------------------------------------
  // The band records come from `src/plan/roadworks.js`, which ran the real
  // cross-section renderers. Deriving the material from what was actually
  // painted is the only way the blend, biome and vegetation passes can agree
  // with the artwork; the older second raster here approximated the same roads
  // and disagreed with them at every kerb.
  const builtUp = plan.builtUp ?? (() => true);
  let carriageway = 0;
  let pavement = 0;

  const roadworks = plan.roadworks ?? null;
  if (roadworks) {
    const nearestJunction = roadworks.nearestJunction ?? (() => 254);
    for (const square of roadworks.bands.entries()) {
      const { x, y, band, surfaceHint } = square;
      if (!surfaceHint || !surfaces.inside(x, y)) continue;
      // The kerb square is tarmac too, and has to age with the road it edges —
      // a stripe of pristine Road_06 down the side of a worn Road_07 street is
      // as visible as no kerb at all.
      const paved = band === 'carriageway' || band === 'bridge-deck' || band === 'kerb';
      const context = paved || band === 'shoulder'
        ? {
          roadClass: square.roadClass,
          traffic: square.traffic,
          condition: square.condition,
          edge: square.edge,
          junctionDistance: nearestJunction(x, y),
        }
        : null;
      // Tarmac is not one material. Which of the three a square gets comes from
      // the same coherent field the grime overlay uses, so a worn stretch is
      // worn all the way through rather than clean asphalt with dirt on it.
      const material = paved && surfaceHint === 'road'
        ? roadMaterialAt(x, y, fields, { ...context, surface: 'road' })
        : surfaceHint;
      surfaces.set(x, y, material, BAND_OWNER[band] ?? 'road');
      if (context) {
        surfaces.setRoadContext(x, y, context);
        if (band !== 'kerb') carriageway++;
      } else if (band === 'sidewalk') {
        pavement++;
      }
    }
  } else {
    // Small callers and tests may hand a plan with no roadworks. They get the
    // carriageway footprint and nothing else, which is honest about the fact
    // that no artwork was chosen for it.
    const roads = plan.roads.ways ?? [];
    const junctions = roadJunctions(roads);
    for (const road of roads) {
      const spec = classifyRoad(road, profile);
      if (!spec) continue;
      const tags = road.tags ?? road;
      const loose = LOOSE_ROAD_SURFACES.has(tags.surface);
      const material = spec.cls === 'track' || loose ? 'gravel' : 'road';
      const traffic = roadTrafficProxy(road, spec);
      const condition = roadCondition(road);
      const half = spec.width / 2;
      forEachInBand(road.points, half, (x, y, dist) => {
        surfaces.set(x, y, material, 'road');
        surfaces.setRoadContext(x, y, {
          roadClass: spec.cls,
          traffic,
          condition,
          edge: half > 0 ? dist / half : 0,
          junctionDistance: junctionDistanceForRoad(road, junctions, x, y),
        });
        carriageway++;
      });
    }
    for (const road of roads) {
      const spec = classifyRoad(road, profile);
      const hasSidewalk = spec && ['left', 'right'].some(
        (side) => spec.sides[side].sidewalk.presence !== 'none',
      );
      if (!hasSidewalk) continue;
      const half = spec.width / 2;
      // One square of pavement: measured across 25,705 Muldraugh kerb squares,
      // 82.6% of pavements are exactly that wide.
      forEachInBand(road.points, half + 1, (x, y, dist) => {
        if (dist <= half) return;
        if (!builtUp(x, y)) return;
        if (surfaces.get(x, y) === 'road') return; // never over a carriageway
        surfaces.set(x, y, 'pavement', 'road');
        pavement++;
      });
    }
  }
  log(`roads: ${carriageway} squares of carriageway, ${pavement} of pavement`);

  return surfaces;
}

/** Scanline-fill a polygon into the surface grid. `surface` may vary by square. */
export function fillPolygon(surfaces, points, surface, owner = null) {
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
        const selected = typeof surface === 'function' ? surface(x, y) : surface;
        if (!selected) continue;
        surfaces.set(x, y, selected, owner);
        painted++;
      }
    }
  }
  return painted;
}

// Kept exported here because this module owned them before they were shared.
export { capsuleRows, forEachInBand };

// Re-exported: these moved to ./roadworks.js when the real renderer took over.
export { roadCondition, roadTrafficProxy };
