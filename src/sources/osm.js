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
 * Ask for buildings, roads, and the land cover we paint the ground with.
 * `out geom` gives coordinates inline, so no second pass to resolve node ids.
 */
export function buildQuery(bbox, timeoutS = 180) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `[out:json][timeout:${timeoutS}];
(
  way["building"](${b});
  relation["building"](${b});
  way["highway"](${b});
  way["landuse"](${b});
  way["natural"](${b});
  way["leisure"~"^(park|pitch|garden|golf_course)$"](${b});
  way["waterway"](${b});
  way["amenity"="parking"](${b});
);
out geom;`;
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
export function normalise(overpass) {
  const buildings = [];
  const roads = [];
  const ground = [];

  for (const el of overpass.elements ?? []) {
    const tags = el.tags ?? {};
    const geometry = el.geometry;
    if (!geometry || geometry.length < 2) continue;

    const points = geometry.map((g) => [g.lon, g.lat]);
    const fid = hashGeometry(points);

    if (tags.building || tags['building:part']) {
      buildings.push({
        kind: 'building',
        fid,
        points: closeRing(points),
        tags,
        levels: parseLevels(tags),
        name: tags.name ?? null,
      });
    } else if (tags.highway) {
      roads.push({
        kind: 'road',
        fid,
        points,
        tags,
        highway: tags.highway,
        lanes: parseIntOr(tags.lanes, null),
        oneway: tags.oneway === 'yes',
        name: tags.name ?? null,
      });
    } else if (tags.landuse || tags.natural || tags.leisure || tags.waterway || tags.amenity) {
      ground.push({
        kind: 'ground',
        fid,
        points: closeRing(points),
        tags,
      });
    }
  }

  return { buildings, roads, ground };
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
