import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { normalise, ATTRIBUTION } from '../sources/osm.js';
import { Projection } from '../geo/project.js';
import { dominantBearing } from '../geo/orient.js';
import { TileCanvas } from '../plan/grid.js';
import {
  classifyRoad,
  createCurbPlan,
  finalizeCurbs,
  finalizeSidewalks,
  loadRoadProfile,
  paintRoad,
} from '../plan/roads.js';
import { FLOOR, FLOOR_FURNITURE, FLOOR_OVERLAY } from '../prefab/layers.js';
import { CELL_SIZE } from '../formats/lotheader.js';

export const FIXTURE_IDS = Object.freeze(['urban', 'suburban', 'rural', 'highway', 'bridge']);
export const AUDIT_SCHEMA = 1;
const WORLD_SIZE = CELL_SIZE * 4;
const CENTRE = WORLD_SIZE / 2;
const ROAD_TILE_FAMILIES = Object.freeze([
  'blends_natural_01',
  'blends_street_01',
  'floors_exterior_tilesandstone_01',
  'street_curbs_01',
  'street_curbs_01_diag',
  'street_curbs_01_diag_2',
  'street_trafficlines_01',
]);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function familyOf(tile) {
  return String(tile).replace(/_\d+$/, '');
}

function pointsOf(element) {
  if (Array.isArray(element.geometry)) {
    return element.geometry.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon));
  }
  if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) return [{ lat: element.lat, lon: element.lon }];
  return [];
}

function anchorOf(payload) {
  const wanted = payload.fixture?.anchorElement;
  const anchor = (payload.elements ?? []).find((element) => `${element.type}/${element.id}` === wanted);
  const points = pointsOf(anchor);
  if (!points.length) throw new Error(`${payload.fixture?.id ?? 'fixture'} has no usable anchor geometry`);
  const sum = points.reduce((out, point) => ({ lat: out.lat + point.lat, lon: out.lon + point.lon }), { lat: 0, lon: 0 });
  return { lat: sum.lat / points.length, lon: sum.lon / points.length };
}

function roadLength(road, projection) {
  let length = 0;
  const points = road.points.map(([lon, lat]) => projection.toLocalMetres(lon, lat));
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return length;
}

function selectTargetRoad(roads, id, projection) {
  const preferred = roads.filter((road) => {
    if (id === 'highway') return /^(motorway|trunk)(_link)?$/.test(road.highway);
    if (id === 'bridge') return road.tags?.bridge && !['no', 'false', '0'].includes(String(road.tags.bridge));
    if (id === 'rural') return ['track', 'unclassified', 'tertiary'].includes(road.highway);
    return road.highway === 'residential';
  });
  const pool = preferred.length ? preferred : roads;
  return [...pool].sort((a, b) => roadLength(b, projection) - roadLength(a, projection))[0] ?? null;
}

function projectedFixture(payload) {
  const features = normalise(payload);
  const anchor = anchorOf(payload);
  const flat = new Projection({ ...anchor, metresPerTile: 1, bearing: 0 });
  const target = selectTargetRoad(features.roads, payload.fixture.id, flat);
  const forBearing = features.roads.map((road) => ({
    points: road.points.map(([lon, lat]) => flat.toLocalMetres(lon, lat)),
  }));
  const bearing = dominantBearing(forBearing);
  const probe = new Projection({ ...anchor, metresPerTile: 1, bearing });
  const targetPoints = target?.points.map(([lon, lat]) => probe.toTile(lon, lat)) ?? [[0, 0]];
  const minX = Math.min(...targetPoints.map(([x]) => x));
  const maxX = Math.max(...targetPoints.map(([x]) => x));
  const minY = Math.min(...targetPoints.map(([, y]) => y));
  const maxY = Math.max(...targetPoints.map(([, y]) => y));
  const projection = probe.with({
    originTileX: Math.round(CENTRE - (minX + maxX) / 2),
    originTileY: Math.round(CENTRE - (minY + maxY) / 2),
  });
  const project = (points) => points.map(([lon, lat]) => projection.toTile(lon, lat));
  const touches = (points) => points.some(([x, y]) => x >= 0 && y >= 0 && x < WORLD_SIZE && y < WORLD_SIZE);
  return {
    features,
    bearing,
    roads: features.roads.map((road) => ({ ...road, points: project(road.points) })).filter((road) => touches(road.points)),
    buildings: features.buildings.map((building) => ({ ...building, points: project(building.points) })).filter((building) => touches(building.points)),
  };
}

function renderedFamilies(canvas) {
  const families = new Set();
  for (const { layers } of canvas.entries()) {
    for (const tile of Object.values(layers)) families.add(familyOf(tile));
  }
  return [...families].sort();
}

function tileCount(canvas, predicate) {
  let count = 0;
  for (const entry of canvas.entries()) {
    for (const [layer, tile] of Object.entries(entry.layers)) if (predicate(tile, layer, entry)) count++;
  }
  return count;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

/** Stable visual-repetition and cell-workload evidence for benchmark reports. */
function renderedMetrics(canvas) {
  const tiles = new Map();
  const families = new Map();
  const cellSquares = new Map();
  let placements = 0;
  let sameNeighborPairs = 0;
  let neighborPairs = 0;
  for (const { x, y, layers } of canvas.entries()) {
    const cell = `${Math.floor(x / CELL_SIZE)},${Math.floor(y / CELL_SIZE)}`;
    cellSquares.set(cell, (cellSquares.get(cell) ?? 0) + 1);
    for (const tile of Object.values(layers)) {
      placements++;
      tiles.set(tile, (tiles.get(tile) ?? 0) + 1);
      const family = familyOf(tile);
      families.set(family, (families.get(family) ?? 0) + 1);
    }
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const neighbor = canvas.get(x + dx, y + dy);
      if (!neighbor) continue;
      for (const [layer, tile] of Object.entries(layers)) {
        if (!neighbor[layer]) continue;
        neighborPairs++;
        if (neighbor[layer] === tile) sameNeighborPairs++;
      }
    }
  }
  const highestShare = (counts) => placements
    ? Math.max(0, ...counts.values()) / placements
    : 0;
  const occupied = [...cellSquares.values()].sort((a, b) => a - b);
  return {
    tilePlacements: placements,
    uniqueTiles: tiles.size,
    uniqueFamilies: families.size,
    dominantTileShare: Number(highestShare(tiles).toFixed(6)),
    dominantFamilyShare: Number(highestShare(families).toFixed(6)),
    adjacentSameTileRate: neighborPairs ? Number((sameNeighborPairs / neighborPairs).toFixed(6)) : 0,
    occupiedCells: occupied.length,
    squaresPerOccupiedCell: {
      min: occupied[0] ?? 0,
      median: percentile(occupied, 0.5),
      p95: percentile(occupied, 0.95),
      max: occupied.at(-1) ?? 0,
    },
  };
}

function featureCounts(id, projected, canvas, curbPlan) {
  const roadSpecs = projected.roads.map((road) => ({ road, spec: classifyRoad(road) })).filter(({ spec }) => spec);
  const families = new Set(renderedFamilies(canvas));
  const counts = {
    building: projected.buildings.length,
    'residential-road': roadSpecs.filter(({ road }) => road.highway === 'residential').length,
    sidewalk: tileCount(canvas, (tile) => familyOf(tile) === 'floors_exterior_tilesandstone_01'),
    'rural-road': roadSpecs.filter(({ road, spec }) => spec.hierarchy === 'rural' || ['track', 'unclassified', 'tertiary'].includes(road.highway)).length,
    highway: roadSpecs.filter(({ spec }) => spec.hierarchy === 'highway').length,
    shoulder: families.has('blends_street_01') && roadSpecs.some(({ spec }) => spec.hierarchy === 'highway') ? 1 : 0,
    'lane-marking': tileCount(canvas, (tile, layer) => layer === FLOOR_OVERLAY && familyOf(tile) === 'street_trafficlines_01'),
    bridge: curbPlan.bridges.length,
    'bridge-deck': curbPlan.bridgeDeck.size,
    'bridge-edge': curbPlan.bridgeEdge.size,
  };
  return Object.fromEntries((projected.features ? Object.keys(counts) : []).map((key) => [key, counts[key]]));
}

function overlapAudit(canvas, curbPlan) {
  let curbOnCarriageway = 0;
  let sidewalkOnCarriageway = 0;
  let ordinaryEdgeOnBridge = 0;
  for (const key of curbPlan.carriageway) {
    if (curbPlan.renderedCurbs.has(key)) curbOnCarriageway++;
    if (curbPlan.renderedSidewalks.has(key)) sidewalkOnCarriageway++;
  }
  for (const key of curbPlan.bridgeClearance) {
    if (curbPlan.renderedCurbs.has(key)) ordinaryEdgeOnBridge++;
  }
  let bridgeDeckEdge = 0;
  for (const key of curbPlan.bridgeDeck) if (curbPlan.bridgeEdge.has(key)) bridgeDeckEdge++;
  return { curbOnCarriageway, sidewalkOnCarriageway, ordinaryEdgeOnBridge, bridgeDeckEdge };
}

function floorNear(canvas, x, y, radius = 2) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) if (canvas.get(Math.round(x + dx), Math.round(y + dy))?.[FLOOR]) return true;
  }
  return false;
}

function seamAudit(roads, canvas) {
  let crossings = 0;
  let gaps = 0;
  const seams = [CELL_SIZE, CELL_SIZE * 2, CELL_SIZE * 3];
  for (const road of roads) {
    for (let i = 1; i < road.points.length; i++) {
      const [ax, ay] = road.points[i - 1];
      const [bx, by] = road.points[i];
      for (const seam of seams) {
        if ((ax < seam && bx >= seam) || (bx < seam && ax >= seam)) {
          const t = (seam - ax) / (bx - ax);
          const y = ay + (by - ay) * t;
          if (y >= 0 && y < WORLD_SIZE) {
            crossings++;
            if (!floorNear(canvas, seam - 1, y) || !floorNear(canvas, seam, y)) gaps++;
          }
        }
        if ((ay < seam && by >= seam) || (by < seam && ay >= seam)) {
          const t = (seam - ay) / (by - ay);
          const x = ax + (bx - ax) * t;
          if (x >= 0 && x < WORLD_SIZE) {
            crossings++;
            if (!floorNear(canvas, x, seam - 1) || !floorNear(canvas, x, seam)) gaps++;
          }
        }
      }
    }
  }
  return { crossings, gaps };
}

export function buildFixture(payload, manifestEntry = null) {
  const projected = projectedFixture(payload);
  const canvas = new TileCanvas();
  const curbPlan = createCurbPlan();
  const profile = loadRoadProfile();
  const inWorld = (x, y) => x >= 0 && y >= 0 && x < WORLD_SIZE && y < WORLD_SIZE;
  const builtUp = () => ['urban', 'suburban'].includes(payload.fixture.id);
  let renderedRoads = 0;
  const orderedRoads = [...projected.roads].sort((a, b) =>
    Number(Boolean(a.tags?.bridge)) - Number(Boolean(b.tags?.bridge)));
  for (const road of orderedRoads) {
    const spec = classifyRoad(road, profile);
    if (!spec) continue;
    paintRoad(canvas, road, spec, { inWorld, builtUp, curbPlan }, profile);
    renderedRoads++;
  }
  finalizeSidewalks(canvas, curbPlan);
  finalizeCurbs(canvas, curbPlan);

  const features = featureCounts(payload.fixture.id, projected, canvas, curbPlan);
  const required = payload.fixture.requiredFeatureClasses ?? manifestEntry?.requiredFeatureClasses ?? [];
  const missing = required.filter((feature) => !(features[feature] > 0));
  return {
    id: payload.fixture.id,
    sourceCache: payload.fixture.sourceCache,
    anchorElement: payload.fixture.anchorElement,
    payloadSha256: manifestEntry?.sha256 ?? null,
    sourceElements: payload.elements?.length ?? 0,
    normalized: Object.fromEntries(['buildings', 'roads', 'ground', 'objects', 'pois'].map((key) => [key, projected.features[key].length])),
    bearing: Number(projected.bearing.toFixed(4)),
    rendered: {
      roads: renderedRoads,
      squares: canvas.size,
      families: renderedFamilies(canvas),
      metrics: renderedMetrics(canvas),
    },
    requiredFeatureClasses: required,
    featureCounts: features,
    missingFeatureClasses: missing,
    invalidOverlaps: overlapAudit(canvas, curbPlan),
    seams: seamAudit(projected.roads, canvas),
  };
}

export function auditFixtures(fixturesDir, baseline = null) {
  const manifestPath = path.join(fixturesDir, 'manifest.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  if (manifest.attribution !== ATTRIBUTION) throw new Error('real-world fixture attribution is missing or changed');
  const builds = [];
  for (const id of FIXTURE_IDS) {
    const entry = manifest.fixtures.find((fixture) => fixture.id === id);
    if (!entry) throw new Error(`manifest is missing required fixture ${id}`);
    const text = fs.readFileSync(path.join(fixturesDir, entry.file), 'utf8');
    if (sha256(text) !== entry.sha256) throw new Error(`${entry.file} does not match its pinned sha256`);
    builds.push(buildFixture(JSON.parse(text), entry));
  }
  const families = [...new Set(builds.flatMap((build) => build.rendered.families))].sort();
  const report = {
    schemaVersion: AUDIT_SCHEMA,
    attribution: ATTRIBUTION,
    fixtureManifestSha256: sha256(manifestText),
    fixtureIds: FIXTURE_IDS,
    supportedFamilyScope: ROAD_TILE_FAMILIES,
    coveredFamilies: families,
    builds,
  };
  if (baseline) report.regressions = compareCoverage(report, baseline);
  return report;
}

export function compareCoverage(report, baseline) {
  const current = new Set(report.coveredFamilies);
  const missingFamilies = (baseline.coveredFamilies ?? []).filter((family) => !current.has(family));
  const buildRegressions = [];
  for (const expected of baseline.builds ?? []) {
    const actual = report.builds.find((build) => build.id === expected.id);
    if (!actual) {
      buildRegressions.push(`${expected.id}: missing build`);
      continue;
    }
    for (const family of expected.rendered?.families ?? []) {
      if (!actual.rendered.families.includes(family)) buildRegressions.push(`${expected.id}: lost ${family}`);
    }
  }
  return { missingFamilies, buildRegressions };
}

export function assertFixtureAudit(report) {
  const errors = [];
  for (const build of report.builds) {
    if (build.missingFeatureClasses.length) errors.push(`${build.id}: missing ${build.missingFeatureClasses.join(', ')}`);
    for (const [kind, count] of Object.entries(build.invalidOverlaps)) {
      if (count !== 0) errors.push(`${build.id}: ${count} invalid ${kind} overlaps`);
    }
    if (build.seams.crossings < 1) errors.push(`${build.id}: fixture does not exercise a cell seam`);
    if (build.seams.gaps !== 0) errors.push(`${build.id}: ${build.seams.gaps} cell-seam gaps`);
  }
  for (const family of report.regressions?.missingFamilies ?? []) errors.push(`coverage lost supported family ${family}`);
  errors.push(...(report.regressions?.buildRegressions ?? []).map((error) => `coverage ${error}`));
  if (errors.length) throw new Error(`real-world fixture audit failed:\n- ${errors.join('\n- ')}`);
  return report;
}
