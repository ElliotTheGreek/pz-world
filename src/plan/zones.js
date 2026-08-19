/**
 * Painting the biome map — the ground, the vegetation and the zones.
 *
 * This is where Build 42 does most of the work for us. A shipped map carries
 * one 256×256 indexed PNG per cell in `maps/biomemap_<cx>_<cy>.png`, one pixel
 * per world square, and `media/lua/server/metazones/BiomeMapConfig.lua` maps
 * each grey value to a biome and a zone:
 *
 *     0    Water            115  townhouse / TownZone
 *     64   ForagingNav      128  farmmix_forest / Farm
 *     96   $random / DeepForest   141  FarmLand
 *     254  dirt (spawns nothing)  255  primary_forest / DeepForest
 *
 * So we do not have to place a single tree. Painting the right grey and letting
 * the game's own generator populate it produces forests that match everything
 * else in the world, and it costs one small PNG per cell instead of tens of
 * thousands of tile placements.
 *
 * Two rules make the result look deliberate rather than accidental:
 *
 *   * everything defaults to forest, so the edge of the generated area fades
 *     into wilderness the way Knox County does rather than ending at a line;
 *   * every building footprint and every road is painted `dirt`, which
 *     BiomeMapConfig marks as spawning nothing — otherwise worldgen grows a
 *     tree through the middle of a house.
 */

import { loadTagTable } from './buildings.js';
import { loadSemanticRegistry, resolveSemantic } from '../catalogue/semantic-registry.js';
import { SparseGrid } from './grid.js';

/**
 * Scanline-fill a polygon given in world squares.
 *
 * Half-open on the upper edge so that two polygons sharing a border do not
 * both claim the squares along it — a landuse=residential meeting a
 * landuse=forest should have exactly one owner per square.
 */
export function fillPolygon(grid, points, value, bounds = null) {
  if (points.length < 3) return 0;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of points) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  minY = Math.ceil(minY);
  maxY = Math.floor(maxY);
  // A land-cover polygon can extend far past the requested area — Overpass
  // returns whole ways — so clamp rather than allocating cells for a forest
  // three counties over.
  if (bounds) {
    minY = Math.max(minY, bounds.minY);
    maxY = Math.min(maxY, bounds.maxY);
  }

  let painted = 0;
  const xs = [];

  for (let y = minY; y <= maxY; y++) {
    xs.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi === yj) continue;
      const lower = Math.min(yi, yj);
      const upper = Math.max(yi, yj);
      if (y < lower || y >= upper) continue;
      xs.push(xj + ((y - yj) / (yi - yj)) * (xi - xj));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let from = Math.ceil(xs[k]);
      let to = Math.floor(xs[k + 1]);
      if (bounds) {
        from = Math.max(from, bounds.minX);
        to = Math.min(to, bounds.maxX);
      }
      for (let x = from; x <= to; x++) {
        grid.set(x, y, value);
        painted++;
      }
    }
  }
  return painted;
}

/** Convert retained OSM tags to the finite site vocabulary in the asset registry. */
export function siteClassFor(tags = {}) {
  if (tags.amenity === 'parking') {
    const loose = ['gravel', 'fine_gravel', 'compacted', 'unpaved', 'ground', 'dirt', 'earth'];
    return loose.includes(tags.surface) ? 'parking-gravel' : 'parking-paved';
  }
  if (tags.natural === 'water' || tags.waterway || tags.landuse === 'reservoir') return 'water';
  if (tags.natural === 'wood' || tags.landuse === 'forest' || tags.landcover === 'trees') return 'forest';
  if (tags.natural === 'scrub' || ['scrub', 'bushes'].includes(tags.landcover)) return 'scrub';
  if (tags.landuse === 'farmland') return 'farmland';
  if (['farmyard', 'meadow'].includes(tags.landuse)) return tags.landuse;
  if (tags.landuse === 'orchard') return 'orchard';
  if (
    ['grass', 'recreation_ground', 'village_green'].includes(tags.landuse) ||
    ['park', 'pitch', 'garden', 'playground', 'golf_course', 'sports_centre'].includes(tags.leisure) ||
    ['grass', 'flowerbed'].includes(tags.landcover)
  ) return 'managed-green';
  if (['residential', 'commercial', 'retail', 'industrial'].includes(tags.landuse)) return 'built-district';
  if (['construction', 'quarry', 'brownfield'].includes(tags.landuse)) return 'cleared';
  return null;
}

/** Registry-backed surface, ownership, biome and parking treatment for a site. */
export function siteTreatmentFor(tags, registry = loadSemanticRegistry()) {
  const siteClass = siteClassFor(tags);
  if (!siteClass) return null;
  const mapping = resolveSemantic(registry, 'site.treatment', { siteClass });
  if (!mapping) return null;
  const restricted = ['private', 'no'].includes(tags?.access) || tags?.motor_vehicle === 'no';
  return {
    siteClass,
    pixel: mapping.pixel ?? null,
    surface: mapping.surface ?? null,
    owner: mapping.owner ?? null,
    parking: Boolean(mapping.parking) && !restricted,
    mappingId: mapping.id,
  };
}

/** Which grey a landuse/natural polygon paints, or null to leave it alone. */
export function groundPixelFor(tags, table = loadTagTable(), registry = loadSemanticRegistry()) {
  const treatment = siteTreatmentFor(tags, registry);
  if (treatment?.pixel != null) return treatment.pixel;
  // Keep the measured table as a compatibility fallback for retained semantics that
  // have not yet graduated to an authored site treatment.
  for (const rule of table.ground) {
    const value = tags[rule.tag];
    if (value === undefined) continue;
    if (rule.value === '*' || rule.value === value) return rule.pixel;
  }
  return null;
}

/**
 * Build the biome map for a whole city.
 *
 * @param {{ground: object[], buildings: object[]}} features  points in world squares
 * @param {import('./grid.js').TileCanvas} roadCanvas
 * @param {object[]} placements
 * @param {{bounds: object, log?: Function}} opts
 */
export function paintGround(features, roadCanvas, placements, opts) {
  const table = loadTagTable();
  const grid = new SparseGrid(table.defaultGroundPixel);
  const log = opts.log ?? (() => {});

  // Make sure every cell the city touches exists, even the ones that end up
  // pure forest — a missing biome map is a hole in the world.
  const { minX, minY, maxX, maxY } = opts.bounds;
  for (let cx = Math.floor(minX / 256); cx <= Math.floor(maxX / 256); cx++) {
    for (let cy = Math.floor(minY / 256); cy <= Math.floor(maxY / 256); cy++) {
      grid.touch(cx, cy);
    }
  }

  // Land cover first: it is the background everything else is drawn over.
  // Largest polygons first, so a park inside a residential district wins over
  // the district rather than being swallowed by it.
  const sorted = [...features.ground].sort((a, b) => polygonArea(b.points) - polygonArea(a.points));
  let coverPainted = 0;
  for (const g of sorted) {
    const pixel = groundPixelFor(g.tags, table);
    if (pixel === null) continue;
    coverPainted += fillPolygon(grid, g.points, pixel, opts.bounds);
  }
  log(`land cover: ${sorted.length} polygons, ${coverPainted} squares`);

  // Then the built ground. Roads and buildings must spawn no vegetation.
  //
  // Clamped to the world: a road clipped at the boundary can still round a
  // square outside it, and one stray square allocates a whole 65 kB cell that
  // then has to be written out as a file.
  const built = table.builtGroundPixel;
  const inWorld = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  let builtPainted = 0;
  for (const { x, y } of roadCanvas.entries()) {
    if (!inWorld(x, y)) continue;
    grid.set(x, y, built);
    builtPainted++;
  }
  for (const p of placements) {
    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) {
        if (!inWorld(p.x + dx, p.y + dy)) continue;
        grid.set(p.x + dx, p.y + dy, built);
        builtPainted++;
      }
    }
  }
  log(`built ground: ${builtPainted} squares over ${grid.cellCount} cells`);

  return grid;
}

export function polygonArea(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(a) / 2;
}

/**
 * A cheap "is this square in town" test, used to gate sidewalks the way
 * Terrula gates them on built-up landcover fraction. Built from the placed
 * buildings rather than from OSM landuse, because a town is where the houses
 * are, whatever the polygons say.
 */
export function builtUpMask(placements, radius = 24) {
  const cells = new Set();
  const step = radius;
  for (const p of placements) {
    const cx = Math.floor((p.x + p.w / 2) / step);
    const cy = Math.floor((p.y + p.h / 2) / step);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) cells.add(`${cx + dx},${cy + dy}`);
    }
  }
  return (x, y) => cells.has(`${Math.floor(x / step)},${Math.floor(y / step)}`);
}
