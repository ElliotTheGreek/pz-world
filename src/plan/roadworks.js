/**
 * The road artwork, for the route that actually ships.
 *
 * `src/plan/roads.js` knows how to draw a road: carriageway, kerb, pavement with
 * corners and ends, grass feathering onto its outer edge, lane lines, junction
 * conflict areas, highway cross-sections, rural verges and ditches, bridge decks
 * and barriers, stop signs and street lamps. None of it reached the world,
 * because it was written against `buildPlan` — the planner the *legacy* worldgen
 * emitter consumes — while the authored-cell route in `src/emit/generate.js`
 * built its own roads out of one flat band of tarmac and a square of pavement.
 *
 * This module is the join. It runs the real renderers over the projected roads
 * and returns three things the authored route needs:
 *
 *   - a `TileCanvas` of chosen sprites, layer by layer;
 *   - a per-square **band** record (carriageway, kerb, sidewalk, shoulder,
 *     median, verge, ditch, bridge deck), so `SurfaceGrid` can agree with the
 *     artwork instead of approximating it a second time;
 *   - the intersection, curb and roadside plans, for auditing.
 *
 * ## Order is the whole design, again
 *
 * Every carriageway is painted before any kerb or pavement, because a junction
 * is two roads and the second one must not lay pavement across the first one's
 * tarmac. Bridges paint last among the ways so a deck owns its footprint.
 * Junctions, curb openings, pavements, kerbs and finally roadside furniture
 * follow, each seeing a completed mask from the step before.
 */

import { TileCanvas } from './grid.js';
import {
  buildIntersectionTopology,
  classifyRoad,
  createCurbPlan,
  finalizeCurbs,
  finalizeSidewalks,
  isBridgeRoad,
  loadRoadProfile,
  markCurbOpening,
  paintRoad,
  renderIntersections,
  renderJunctionMarkings,
} from './roads.js';
import { planRoadsideFeatures, renderRoadsideFeatures } from './roadside.js';
import { loadSemanticRegistry } from '../catalogue/semantic-registry.js';

/**
 * Which authored ground material a rendered band is made of.
 *
 * The surface grid has nine materials and the renderer has a dozen bands; this
 * is the mapping between them, and it is deliberately explicit rather than
 * derived from the tile name. `null` means the band contributes no material —
 * the kerb sits on whatever the pavement or carriageway beside it decided, and a
 * lane line is an overlay on tarmac that is already tarmac.
 */
export const BAND_SURFACE = Object.freeze({
  carriageway: 'road',
  marking: null,
  // A kerb is a `FloorFurniture` sprite laid over a floor, and it needs one.
  // Measured under all 67,254 kerb squares in the sixteen busiest Muldraugh
  // cells: 70% sit on the street sheet, 18% on pavement, 10% on grass. Leaving
  // this null left every kerb in a generated city floating on the land cover
  // underneath — grass, usually — which also cost the kerbside parking pass its
  // squares, because a car may not stand on a lawn.
  kerb: 'road',
  sidewalk: 'pavement',
  shoulder: 'gravel',
  median: 'grass',
  verge: 'grass',
  ditch: 'grass',
  'bridge-deck': 'road',
  'bridge-edge': 'gravel',
});

/** Bands that own their square outright and must not be replanted or blended over. */
export const BAND_OWNER = Object.freeze({
  carriageway: 'road',
  kerb: 'road',
  sidewalk: 'road',
  shoulder: 'road',
  median: 'managed',
  verge: 'managed',
  ditch: 'managed',
  'bridge-deck': 'road',
  'bridge-edge': 'road',
});

/**
 * How strongly a band claims its square when two roads overlap.
 *
 * A junction is the case that matters: a residential street's verge must never
 * win against the arterial's carriageway it crosses. Higher takes the square.
 */
const BAND_RANK = Object.freeze({
  verge: 1,
  ditch: 1,
  median: 2,
  kerb: 3,
  shoulder: 4,
  sidewalk: 5,
  'bridge-edge': 6,
  carriageway: 7,
  'bridge-deck': 8,
});

/** What the rural renderer's material names mean to the surface grid. */
const RURAL_MATERIAL_SURFACE = Object.freeze({ paved: 'road', gravel: 'gravel', dirt: 'dirt' });

/** OSM surface values that make a carriageway aggregate rather than tarmac. */
export const LOOSE_ROAD_SURFACES = new Set([
  'gravel', 'fine_gravel', 'compacted', 'unpaved', 'ground', 'dirt', 'earth',
  'sand', 'grass', 'mud', 'pebblestone',
]);

/** The authored material of a paved band, before the renderer refines it. */
export function carriagewayMaterial(road, spec) {
  const surface = String((road.tags ?? road).surface ?? '').toLowerCase();
  if (spec.cls === 'track' || LOOSE_ROAD_SURFACES.has(surface)) return 'gravel';
  return 'road';
}

const TRAFFIC_BY_CLASS = Object.freeze({
  motorway: 1, trunk: 0.92, primary: 0.82, secondary: 0.68,
  residential: 0.42, service: 0.27, cycleway: 0.12, track: 0.08, footway: 0.04,
});

/** OSM has no universal traffic count, so hierarchy, lanes and speed form the proxy. */
export function roadTrafficProxy(road, spec) {
  const tags = road.tags ?? road;
  const lanes = Number(tags.lanes ?? road.lanes) || 0;
  const speed = Number.parseFloat(String(tags.maxspeed ?? road.maxspeed ?? ''));
  const laneBoost = Math.min(0.12, Math.max(0, lanes - 2) * 0.025);
  const speedBoost = Number.isFinite(speed) ? Math.min(0.08, Math.max(-0.05, (speed - 50) / 500)) : 0;
  return Math.max(0, Math.min(1, (TRAFFIC_BY_CLASS[spec.cls] ?? 0.3) + laneBoost + speedBoost));
}

/** Normalise heterogeneous OSM condition/smoothness values to a stable wear category. */
export function roadCondition(road) {
  const tags = road.tags ?? road;
  const raw = String(tags.condition ?? tags.smoothness ?? '').toLowerCase();
  if (['excellent', 'very_good'].includes(raw)) return 'excellent';
  if (raw === 'good') return 'good';
  if (['bad', 'poor', 'very_bad'].includes(raw)) return 'poor';
  if (['horrible', 'very_horrible', 'impassable', 'damaged'].includes(raw)) return 'damaged';
  if (['worn', 'intermediate', 'uneven'].includes(raw)) return 'worn';
  return 'average';
}

/**
 * Where a square is, in squares, from the nearest junction on its own road.
 *
 * Wear concentrates where traffic brakes and turns, so this is what makes a
 * junction approach scuff while the middle of a straight stays clean.
 */
function junctionField(intersections) {
  const points = intersections.map(({ x, y }) => [x, y]);
  // A city has a few thousand junctions and tens of millions of road squares, so
  // the lookup is bucketed rather than scanned.
  const CELL = 32;
  const buckets = new Map();
  for (const [x, y] of points) {
    const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push([x, y]);
  }
  return (x, y) => {
    let nearest = 254;
    const gx = Math.floor(x / CELL);
    const gy = Math.floor(y / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const [jx, jy] of buckets.get(`${gx + dx},${gy + dy}`) ?? []) {
          const d = Math.hypot(x - jx, y - jy);
          if (d < nearest) nearest = d;
        }
      }
    }
    return nearest;
  };
}

/**
 * A compact per-square record of what the renderer decided.
 *
 * One entry per painted square rather than one per write: a square painted by
 * three overlapping ways keeps the highest-ranking band, which is what stops a
 * side street's verge cutting a notch out of the arterial it joins.
 */
class BandGrid {
  constructor() {
    /** @type {Map<number, {band: string, roadClass: string, traffic: number, condition: string, edge: number, surfaceHint: string|null}>} */
    this.squares = new Map();
  }

  static key(x, y) {
    return (x + (1 << 21)) * (1 << 22) + (y + (1 << 21));
  }

  record(x, y, entry) {
    const key = BandGrid.key(x, y);
    const previous = this.squares.get(key);
    if (previous && (BAND_RANK[previous.band] ?? 0) > (BAND_RANK[entry.band] ?? 0)) {
      // A lower band still contributes its wear hint where the winner has none.
      previous.edge = Math.max(previous.edge, entry.edge);
      return;
    }
    this.squares.set(key, entry);
  }

  get size() {
    return this.squares.size;
  }

  *entries() {
    for (const [key, value] of this.squares) {
      const y = (key % (1 << 22)) - (1 << 21);
      const x = (key - (y + (1 << 21))) / (1 << 22) - (1 << 21);
      yield { x, y, ...value };
    }
  }
}

/**
 * Run the full road renderer over projected ways.
 *
 * @param {object} opts
 * @param {object[]} opts.roads projected ways, points in world squares
 * @param {object[]} [opts.objects] projected point features (crossings, signals, signs)
 * @param {{x:number,y:number,w:number,h:number}[]} [opts.placements] placed buildings
 * @param {{minX,minY,maxX,maxY}} opts.bounds
 * @param {(x:number,y:number)=>boolean} [opts.builtUp]
 */
export function planRoadworks({
  roads = [],
  objects = [],
  placements = [],
  bounds,
  builtUp = () => true,
  profile = loadRoadProfile(),
  semanticRegistry = loadSemanticRegistry(),
  log = () => {},
  onProgress = () => {},
}) {
  const canvas = new TileCanvas();
  const bandGrid = new BandGrid();
  const curbPlan = createCurbPlan();
  const inWorld = (x, y) =>
    x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;

  for (const placement of placements) {
    for (let y = placement.y; y < placement.y + placement.h; y++) {
      for (let x = placement.x; x < placement.x + placement.w; x++) {
        curbPlan.buildingFootprint.add(`${x},${y}`);
      }
    }
  }

  // Bridges last: an elevated deck owns everything under its footprint, and it
  // can only claim that once the ways it crosses have painted themselves.
  const ordered = [...roads].sort((a, b) => Number(isBridgeRoad(a)) - Number(isBridgeRoad(b)));
  const renderable = [];
  let writes = 0;
  let ways = 0;

  // Painted one way at a time, and it says so as it goes. This loop is minutes
  // of work on a city-sized road network, and it used to run behind a single
  // unchanging line on the build screen — which is indistinguishable from a
  // hang, and was reported as one.
  let reported = 0;
  for (const [index, road] of ordered.entries()) {
    if (index - reported >= 25 || index === 0) {
      reported = index;
      onProgress(index / ordered.length, ordered.length, null);
    }
    const spec = road.crossSection ?? classifyRoad(road, profile);
    if (!spec || (road.points?.length ?? 0) < 2) continue;
    const traffic = roadTrafficProxy(road, spec);
    const condition = roadCondition(road);
    const half = Math.max(0.5, spec.width / 2);
    const paving = carriagewayMaterial(road, spec);

    writes += paintRoad(canvas, road, spec, {
      builtUp,
      inWorld,
      curbPlan,
      semanticRegistry,
      onBand: (sample) => {
        let surfaceHint = BAND_SURFACE[sample.band];
        if (surfaceHint === undefined) return;
        // A limited-access road's hard shoulder is paved; a country lane's is
        // aggregate. Same band name, different material, and only the renderer
        // that drew it knows which.
        if (sample.band === 'shoulder' && sample.renderer === 'highway') surfaceHint = 'road';
        // The rural renderer decided its own material per way; everything else
        // takes the tag-derived one. Recording what was drawn rather than what
        // the class implies is what keeps the blend edges honest around a dirt
        // track running through a field.
        if (surfaceHint === 'road') {
          surfaceHint = sample.material ? RURAL_MATERIAL_SURFACE[sample.material] ?? 'road' : paving;
        }
        bandGrid.record(sample.x, sample.y, {
          band: sample.band,
          roadClass: spec.cls,
          traffic,
          condition,
          edge: Math.min(1, sample.distance / half),
          surfaceHint,
        });
      },
    }, profile);
    renderable.push({ ...road, spec });
    ways++;
  }

  onProgress(1, ordered.length, 'Working out the junctions');
  const intersections = buildIntersectionTopology(renderable, profile);
  writes += renderIntersections(canvas, intersections, curbPlan, { inWorld, builtUp }, semanticRegistry);

  // A junction's fill is authored after the ways, so its squares are recorded
  // here rather than through `onBand`. They are carriageway by construction.
  for (const intersection of curbPlan.intersections) {
    const radius = Math.ceil(intersection.radius);
    const primary = intersection.arms?.reduce(
      (best, arm) => (!best || arm.width > best.width ? arm : best), null);
    for (let y = intersection.y - radius; y <= intersection.y + radius; y++) {
      for (let x = intersection.x - radius; x <= intersection.x + radius; x++) {
        if (!curbPlan.carriageway.has(`${x},${y}`)) continue;
        const existing = bandGrid.squares.get(BandGrid.key(x, y));
        bandGrid.record(x, y, {
          band: 'carriageway',
          roadClass: primary?.roadClass ?? existing?.roadClass ?? 'residential',
          traffic: existing?.traffic ?? 0.5,
          condition: existing?.condition ?? 'average',
          edge: 0,
          surfaceHint: 'road',
        });
      }
    }
  }

  // Point features are independent OSM elements, so their curb cuts land only
  // after every carriageway has contributed to the shared topology mask.
  for (const object of objects) {
    const [point] = object.points ?? [];
    if (!point) continue;
    if (object.kind === 'crossing') markCurbOpening(curbPlan, point[0], point[1], 8, 'crossing');
    if (object.kind === 'junction') markCurbOpening(curbPlan, point[0], point[1], 3, 'junction');
    if (object.kind === 'barrier' && ['entrance', 'gate'].includes(object.tags?.barrier)) {
      markCurbOpening(curbPlan, point[0], point[1], 1, 'entrance');
    }
  }

  onProgress(1, ordered.length, 'Laying the pavements');
  writes += finalizeSidewalks(canvas, curbPlan, semanticRegistry,
    (f) => onProgress(1, ordered.length, `Laying the pavements  (${Math.round(f * 100)}%)`));
  onProgress(1, ordered.length, 'Cutting the kerbs');
  writes += finalizeCurbs(canvas, curbPlan, semanticRegistry,
    (f) => onProgress(1, ordered.length, `Cutting the kerbs  (${Math.round(f * 100)}%)`));

  // The deferred passes decide which candidates survive, so the band grid learns
  // the answer from them rather than from the candidate list.
  for (const key of curbPlan.renderedSidewalks) {
    const [x, y] = key.split(',').map(Number);
    const existing = bandGrid.squares.get(BandGrid.key(x, y));
    bandGrid.record(x, y, {
      band: 'sidewalk',
      roadClass: existing?.roadClass ?? 'residential',
      traffic: existing?.traffic ?? 0.3,
      condition: existing?.condition ?? 'average',
      edge: 1,
      surfaceHint: 'pavement',
    });
  }

  // Stop bars go on after the curbs and pavements they must not sit under.
  onProgress(1, ordered.length, 'Painting the junction markings');
  writes += renderJunctionMarkings(canvas, curbPlan, semanticRegistry);

  onProgress(1, ordered.length, 'Putting up signs and street lamps');
  const roadside = planRoadsideFeatures({
    objects, roads: renderable, intersections, curbPlan, inWorld,
  });
  writes += renderRoadsideFeatures(canvas, roadside, semanticRegistry);

  const nearestJunction = junctionField(curbPlan.intersections);
  const topologies = {};
  for (const intersection of curbPlan.intersections) {
    topologies[intersection.topology] = (topologies[intersection.topology] ?? 0) + 1;
  }
  const bandCounts = {};
  for (const square of bandGrid.entries()) {
    bandCounts[square.band] = (bandCounts[square.band] ?? 0) + 1;
  }

  log(
    `roadworks: ${ways} ways, ${canvas.size} squares, ${writes} tile writes, ` +
      `${curbPlan.intersections.length} junctions, ${curbPlan.renderedCurbs.size} curbs, ` +
      `${curbPlan.renderedSidewalks.size} pavement squares, ` +
      `${roadside.stats.total} signs/lamps (${roadside.stats.inferred} inferred)`,
  );

  return {
    canvas,
    bands: bandGrid,
    curbPlan,
    intersections: curbPlan.intersections,
    roadside,
    nearestJunction,
    stats: {
      ways,
      squares: canvas.size,
      writes,
      bands: bandCounts,
      curbs: curbPlan.renderedCurbs.size,
      sidewalks: curbPlan.renderedSidewalks.size,
      bridges: curbPlan.bridges.length,
      intersections: curbPlan.intersections.length,
      topologies,
      roadside: roadside.stats,
    },
  };
}
