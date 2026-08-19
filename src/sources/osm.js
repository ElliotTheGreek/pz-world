/**
 * OpenStreetMap ingest, via Overpass.
 *
 * Terrula rules out OSM outright (PREMISE.md decision D1): it plans to ship a
 * commercially-closed world, and ODbL's share-alike obligation on derived
 * databases is a real risk there. That reasoning does not carry over. pz-world
 * generates a free mod, and OSM is the only source that answers the question
 * this project actually asks — *what kind of building is this?* TIGER and FEMA
 * are public domain but FEMA has eight occupancy classes and no shop types, so
 * "stores where stores go" degrades to "commercial buildings where commercial
 * buildings go".
 *
 * The obligation that comes with that choice is attribution, and it is written
 * into the generated mod.info and README rather than left implied. See
 * docs/DECISIONS.md D1.
 *
 * Responses are cached on disk keyed by the query, because Overpass is a shared
 * free service and re-running a generation while tuning a config file should
 * not re-ask it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { hashString, hashGeometry } from '../lib/rng.js';

export const ATTRIBUTION = '© OpenStreetMap contributors, ODbL 1.0';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Overpass has a hard timeout and a shared load budget, so a request that
 * covers a whole county will simply fail. Refusing early with a clear message
 * beats a 504 twelve minutes in.
 */
const MAX_RADIUS_M = 12000;

/**
 * Ask only for feature families the planner can plausibly render. In particular,
 * do not request every tagged node (or recurse to every way node): dense cities
 * make that payload grow far faster than the requested area. `out geom` embeds
 * coordinates while keeping the result to these explicitly bounded selectors.
 */
export function buildQuery(bbox, timeoutS = 180) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const land = '^(forest|farmland|farmyard|meadow|grass|orchard|vineyard|cemetery|residential|commercial|industrial|retail|recreation_ground|village_green|brownfield|construction|quarry|reservoir|basin)$';
  const natural = '^(wood|scrub|grassland|heath|wetland|water|beach|sand|bare_rock|shingle)$';
  const leisure = '^(park|pitch|garden|golf_course|playground|sports_centre)$';
  const road = '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street|service|track|footway|path|pedestrian|cycleway|steps)$';
  const roadNode = '^(crossing|traffic_signals|stop|give_way|turning_circle|mini_roundabout|motorway_junction|street_lamp)$';
  const barrier = '^(bollard|block|chain|cycle_barrier|entrance|fence|gate|guard_rail|hedge|jersey_barrier|kerb|kissing_gate|lift_gate|retaining_wall|sally_port|swing_gate|wall)$';
  const amenity = '^(parking|fuel|hospital|clinic|doctors|pharmacy|police|fire_station|school|college|kindergarten|university|library|restaurant|cafe|fast_food|pub|bar|nightclub|bank|post_office|townhall|courthouse|prison|place_of_worship|community_centre|toilets)$';
  const shop = '^(supermarket|convenience|grocery|greengrocer|bakery|butcher|clothes|department_store|doityourself|hardware|car_repair|car|mall|chemist|medical_supply|general|variety_store)$';
  return `[out:json][timeout:${timeoutS}];
(
  way["building"](${b});
  way["building:part"](${b});
  relation["building"](${b});
  relation["building:part"](${b});
  way["highway"~"${road}"](${b});
  node["highway"~"${roadNode}"](${b});
  node["traffic_sign"](${b});
  way["traffic_sign"](${b});
  node["barrier"~"${barrier}"](${b});
  way["barrier"~"${barrier}"](${b});
  way["landuse"~"${land}"](${b});
  relation["landuse"~"${land}"](${b});
  way["natural"~"${natural}"](${b});
  relation["natural"~"${natural}"](${b});
  way["landcover"~"^(trees|grass|scrub|bushes|flowerbed|bare_rock|sand|gravel)$"](${b});
  relation["landcover"~"^(trees|grass|scrub|bushes|flowerbed|bare_rock|sand|gravel)$"](${b});
  way["leisure"~"${leisure}"](${b});
  relation["leisure"~"${leisure}"](${b});
  way["waterway"~"^(river|stream|canal|drain|ditch)$"](${b});
  relation["waterway"~"^(river|stream|canal|drain|ditch)$"](${b});
  nwr["amenity"~"${amenity}"](${b});
  nwr["shop"~"${shop}"](${b});
  nwr["office"~"^(government|company|association|educational_institution|lawyer|financial|insurance|estate_agent|ngo|healthcare)$"](${b});
  nwr["tourism"~"^(hotel|motel|camp_site|museum|attraction)$"](${b});
);
out geom(${b});`;
}

async function fetchOverpass(query, { log = () => {} } = {}) {
  let lastErr = null;
  for (const endpoint of ENDPOINTS) {
    try {
      log(`querying ${new URL(endpoint).host}`);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'pz-world/0.1 (Project Zomboid map generator)',
        },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      log(`  failed: ${err.message}`);
    }
  }
  throw new Error(`every Overpass endpoint failed. Last error: ${lastErr?.message}`);
}

/**
 * Fetch (or reuse) the raw Overpass response for a bounding box.
 *
 * @param {{south,west,north,east}} bbox
 * @param {{cacheDir: string, refresh?: boolean, log?: Function}} opts
 */
export async function fetchArea(bbox, opts) {
  const { cacheDir, refresh = false, log = () => {} } = opts;
  const query = buildQuery(bbox);
  const key = hashString(query).toString(16);
  const file = path.join(cacheDir, `overpass-${key}.json`);

  if (!refresh && fs.existsSync(file)) {
    log(`using cached Overpass response ${path.basename(file)}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  const json = await fetchOverpass(query, { log });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json));
  log(`cached ${json.elements?.length ?? 0} elements to ${path.basename(file)}`);
  return json;
}

export function checkRadius(radiusM) {
  if (radiusM > MAX_RADIUS_M) {
    throw new Error(
      `radius ${radiusM} m is beyond the ${MAX_RADIUS_M} m cap. Overpass will time out on an ` +
        'area that size. Generate a smaller area, or raise MAX_RADIUS_M in src/sources/osm.js ' +
        'and expect to babysit the query.',
    );
  }
}

/**
 * Normalise Overpass output into the flat shape the planner consumes.
 *
 * The attribute set mirrors Terrula's vector ingest (PREMISE.md §11.4) — one
 * fixed schema, whatever the source — so a second adapter (TIGER, FEMA, a
 * national cadastre) can be dropped in without the planner knowing.
 *
 * `fid` is a hash of the geometry rather than the OSM way id, following
 * Terrula's decision D16. A way id changes when a mapper splits a way in two,
 * and a building whose identity moved would be handed a different prototype
 * for no visible reason.
 */
const RETAINED_TAGS = new Set([
  // Identity and classification.
  'name', 'ref', 'building', 'building:part', 'building:levels', 'height',
  'highway', 'service', 'junction', 'route', 'amenity', 'shop', 'office', 'tourism',
  'landuse', 'landcover', 'natural', 'leisure', 'waterway', 'water', 'barrier',
  // Road cross-section, markings and condition.
  'lanes', 'lanes:forward', 'lanes:backward', 'lanes:both_ways',
  'turn:lanes', 'turn:lanes:forward', 'turn:lanes:backward',
  'oneway', 'width', 'placement', 'placement:forward', 'placement:backward',
  'surface', 'smoothness', 'tracktype', 'maxspeed', 'access', 'motor_vehicle', 'lit',
  'lane_markings', 'lane_markings:forward', 'lane_markings:backward',
  'centre_marking', 'marking:centre', 'markings', 'divider',
  'change:lanes', 'change:lanes:forward', 'change:lanes:backward',
  'surface:condition', 'condition', 'incline',
  'shoulder', 'shoulder:left', 'shoulder:right',
  'shoulder:both', 'shoulder:surface', 'shoulder:left:surface', 'shoulder:right:surface',
  'shoulder:width', 'shoulder:left:width', 'shoulder:right:width', 'shoulder:both:width',
  'cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both',
  'cycleway:surface', 'cycleway:left:surface', 'cycleway:right:surface', 'cycleway:both:surface',
  'cycleway:width', 'cycleway:left:width', 'cycleway:right:width', 'cycleway:both:width',
  'median', 'median:width', 'divider:width',
  // Pedestrian, structures and roadside semantics.
  'sidewalk', 'sidewalk:left', 'sidewalk:right', 'sidewalk:both',
  'sidewalk:surface', 'sidewalk:left:surface', 'sidewalk:right:surface', 'sidewalk:both:surface',
  'sidewalk:width', 'sidewalk:left:width', 'sidewalk:right:width', 'sidewalk:both:width',
  'crossing', 'crossing:markings', 'crossing:signals', 'crossing:island',
  'kerb', 'kerb:left', 'kerb:right', 'tactile_paving',
  'bridge', 'bridge:structure', 'layer', 'covered', 'tunnel',
  'traffic_sign', 'traffic_sign:forward', 'traffic_sign:backward',
  'traffic_sign:direction', 'information', 'direction', 'destination',
  // Parking and vegetation detail used by later mapping tasks.
  'parking', 'parking:left', 'parking:right', 'parking:both',
  'parking:left:orientation', 'parking:right:orientation', 'parking:both:orientation',
  'parking:lane:both', 'parking:lane:left', 'parking:lane:right',
  'parking:width', 'parking:left:width', 'parking:right:width', 'parking:both:width',
  'capacity', 'capacity:disabled',
  'leaf_type', 'leaf_cycle', 'species', 'genus',
]);

const ROAD_POINT_VALUES = new Set([
  'crossing', 'traffic_signals', 'stop', 'give_way', 'turning_circle',
  'mini_roundabout', 'motorway_junction', 'street_lamp',
]);

/**
 * Keep a deliberately finite semantic schema. Overpass selectors constrain the
 * number of elements; this filter also prevents arbitrary editor/import tags
 * from making every feature in the in-memory plan progressively heavier.
 */
function retainTags(tags) {
  return Object.fromEntries(Object.entries(tags).filter(([key]) => RETAINED_TAGS.has(key)));
}

function geometryPoints(geometry) {
  if (!Array.isArray(geometry)) return [];
  return geometry
    .filter((g) => Number.isFinite(g?.lon) && Number.isFinite(g?.lat))
    .map((g) => [g.lon, g.lat]);
}

function samePoint(a, b) {
  return a?.[0] === b?.[0] && a?.[1] === b?.[1];
}

/** Join multipolygon outer member ways without retaining the much larger node graph. */
function stitchSegments(segments) {
  const remaining = segments.filter((segment) => segment.length >= 2).map((segment) => [...segment]);
  const rings = [];
  while (remaining.length) {
    const ring = remaining.shift();
    let joined = true;
    while (!samePoint(ring[0], ring[ring.length - 1]) && joined) {
      joined = false;
      for (let i = 0; i < remaining.length; i++) {
        const segment = remaining[i];
        if (samePoint(ring[ring.length - 1], segment[0])) ring.push(...segment.slice(1));
        else if (samePoint(ring[ring.length - 1], segment[segment.length - 1])) {
          ring.push(...segment.slice(0, -1).reverse());
        } else if (samePoint(ring[0], segment[segment.length - 1])) ring.unshift(...segment.slice(0, -1));
        else if (samePoint(ring[0], segment[0])) ring.unshift(...segment.slice(1).reverse());
        else continue;
        remaining.splice(i, 1);
        joined = true;
        break;
      }
    }
    rings.push(ring);
  }
  return rings;
}

function elementGeometries(el) {
  const direct = geometryPoints(el.geometry);
  if (direct.length) return [direct];
  if (Number.isFinite(el.lon) && Number.isFinite(el.lat)) return [[[el.lon, el.lat]]];
  if (el.type !== 'relation' || !Array.isArray(el.members)) return [];

  // Inner rings are holes, not independently paintable ground/buildings. The
  // current plan schema has no holes, so retain outer rings and avoid turning
  // lakes/islands/courtyards into duplicate filled polygons.
  const outers = el.members
    .filter((member) => member.type === 'way' && member.role !== 'inner')
    .map((member) => geometryPoints(member.geometry));
  return stitchSegments(outers);
}

export function normalise(overpass) {
  const buildings = [];
  const roads = [];
  const ground = [];
  const objects = [];
  const pois = [];

  for (const el of overpass.elements ?? []) {
    const rawTags = el.tags ?? {};
    const tags = retainTags(rawTags);
    for (const points of elementGeometries(el)) {
      if (!points.length) continue;

      const fid = hashGeometry(points);
      const base = { fid, points, tags, name: tags.name ?? null };

      if (tags.building || tags['building:part']) {
        if (points.length < 2) continue;
        buildings.push({
          ...base,
          kind: 'building',
          points: closeRing(points),
          levels: parseLevels(tags),
        });
      } else if (tags.highway && points.length >= 2) {
        roads.push({
          ...base,
          kind: 'road',
          highway: tags.highway,
          lanes: parseIntOr(tags.lanes, null),
          oneway: ['yes', '1', 'true', '-1'].includes(tags.oneway),
        });
      } else if (
        tags.barrier || tags.traffic_sign ||
        (tags.highway && ROAD_POINT_VALUES.has(tags.highway))
      ) {
        objects.push({
          ...base,
          kind: objectKind(tags),
          geometry: points.length === 1 ? 'point' : 'line',
        });
      } else if (
        (tags.amenity || tags.shop || tags.office || tags.tourism) && points.length === 1
      ) {
        pois.push({ ...base, kind: 'poi', geometry: 'point' });
      } else if (
        tags.landuse || tags.landcover || tags.natural || tags.leisure || tags.waterway ||
        tags.amenity === 'parking'
      ) {
        if (points.length < 2) continue;
        ground.push({
          ...base,
          kind: 'ground',
          points: closeRing(points),
        });
      } else if (tags.shop || tags.office || tags.tourism || tags.amenity) {
        pois.push({
          ...base,
          kind: 'poi',
          geometry: points.length >= 3 ? 'area' : 'line',
          points: points.length >= 3 ? closeRing(points) : points,
        });
      }
    }
  }

  return { buildings, roads, ground, objects, pois };
}

function objectKind(tags) {
  if (tags.barrier) return 'barrier';
  if (tags.traffic_sign || tags.highway === 'stop' || tags.highway === 'give_way') return 'sign';
  if (tags.highway === 'crossing') return 'crossing';
  if (tags.highway === 'traffic_signals') return 'signals';
  if (['mini_roundabout', 'turning_circle', 'motorway_junction'].includes(tags.highway)) return 'junction';
  return 'street-furniture';
}

function closeRing(points) {
  if (points.length < 3) return points;
  const [fx, fy] = points[0];
  const [lx, ly] = points[points.length - 1];
  if (fx === lx && fy === ly) return points;
  return [...points, [fx, fy]];
}

function parseIntOr(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Storey count. Recorded even though worldgen prefabs are single-storey,
 * because the lotpack emitter will need it and because it is a useful signal
 * for picking a prototype — a four-storey footprint should not become a
 * bungalow.
 */
function parseLevels(tags) {
  return (
    parseIntOr(tags['building:levels'], null) ??
    (tags.height ? Math.max(1, Math.round(parseFloat(tags.height) / 3)) : null)
  );
}
