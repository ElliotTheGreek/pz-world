/**
 * Laying roads on a square grid at their true bearing.
 *
 * The decision here is the one the whole map's character rests on. Project
 * Zomboid's grid is square, but its road *artwork* is not limited to the two
 * grid axes: the game ships two diagonal kerb sheets — `street_curbs_01_diag`
 * (78 tiles) and `street_curbs_01_diag_2` (79) — declared as `FloorOverlay`,
 * and vanilla uses them in roughly one in six of the Muldraugh cells that have
 * kerbs at all.
 *
 * FloorOverlay is the important word. The kerbs are painted *on top of* square
 * ground, so the walkable grid stays axis-aligned while the visible road edge
 * runs at an angle. That means a street does not have to be snapped to an axis
 * the way a building does. It can follow its real bearing as a stairstep, and
 * where the stairstep happens to run 1:1 the diagonal artwork makes it read as
 * a genuine angled kerb rather than a staircase.
 *
 * So:
 *   * roads keep their true bearing, stairstepped;
 *   * kerbs switch to the diagonal sheet on runs within `diagonalTolerance` of
 *     1:1;
 *   * buildings, which have no such escape hatch, are snapped in
 *     src/plan/buildings.js.
 *
 * The band structure — carriageway, kerb, sidewalk, verge — is Terrula's
 * (PREMISE.md §6.2), reduced from signed distance in metres to a distance in
 * whole squares, because on a fixed square grid there is no seam for the metric
 * version to prevent.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonc } from '../lib/jsonc.js';
import {
  loadSemanticRegistry,
  resolveSemantic,
  selectSemanticVariant,
} from '../catalogue/semantic-registry.js';
import { FLOOR, FLOOR_FURNITURE, FLOOR_OVERLAY } from '../prefab/layers.js';
import { forEachNearPolyline, polylineLength } from './polyline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.resolve(HERE, '../../config/roads.jsonc');

let cached = null;

export function loadRoadProfile(file = CONFIG) {
  if (cached && cached.file === file) return cached;
  const raw = readJsonc(file);
  cached = { file, ...raw, ignore: new Set(raw.ignore ?? []) };
  return cached;
}

const ABSENT = new Set(['no', 'none', 'separate', '0', 'false']);
const PRESENT = new Set(['yes', 'both', 'lane', 'track', 'shared_lane', 'shared', '1', 'true']);

function roadTags(road) {
  return { ...road, ...(road.tags ?? {}) };
}

function positiveNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  const feet = text.match(/^(\d+(?:\.\d+)?)\s*(?:ft|feet|')\s*(?:(\d+(?:\.\d+)?)\s*(?:in|"))?$/);
  if (feet) return Number(feet[1]) * 0.3048 + Number(feet[2] ?? 0) * 0.0254;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)?$/);
  return match && Number(match[1]) > 0 ? Number(match[1]) : null;
}

function laneCount(tags, fallback, highwaySpec) {
  const total = positiveNumber(tags.lanes);
  const forward = positiveNumber(tags['lanes:forward']);
  const backward = positiveNumber(tags['lanes:backward']);
  const bothWays = positiveNumber(tags['lanes:both_ways']) ?? 0;
  const directional = forward || backward ? (forward ?? 0) + (backward ?? 0) + bothWays : null;
  if (total) return { total: Math.max(1, Math.round(total)), source: 'lanes' };
  if (directional) return { total: Math.max(1, Math.round(directional)), source: 'directional-lanes' };
  if (highwaySpec.lanes) return { total: highwaySpec.lanes, source: 'highway-link-fallback' };
  const oneway = ['yes', '1', 'true', '-1'].includes(String(tags.oneway).toLowerCase());
  return {
    total: oneway ? Math.max(1, Math.ceil(fallback / 2)) : fallback,
    source: oneway ? 'oneway-fallback' : 'hierarchy-fallback',
  };
}

function sideValue(tags, key, side) {
  return tags[`${key}:${side}`] ?? tags[`${key}:both`] ?? tags[key];
}

function facilityPresence(value, side, implicit) {
  if (value === undefined || value === null || value === '') return implicit ? 'implicit' : 'none';
  const v = String(value).toLowerCase();
  if (ABSENT.has(v)) return 'none';
  if (v === 'left' || v === 'right') return v === side ? 'explicit' : 'none';
  if (PRESENT.has(v) || !['unknown', 'unknown_side'].includes(v)) return 'explicit';
  return implicit ? 'implicit' : 'none';
}

function facility(tags, key, side, fallback, widths, { implicit = false, surfaceKey = key } = {}) {
  const value = sideValue(tags, key, side);
  const hasFallback = typeof fallback === 'number' && fallback > 0;
  const rawPresence = facilityPresence(value, side, implicit || hasFallback);
  const presence = value === undefined && hasFallback ? 'fallback' : rawPresence;
  const taggedWidth = positiveNumber(
    tags[`${key}:${side}:width`] ?? tags[`${key}:both:width`] ?? tags[`${key}:width`],
  );
  const width = presence === 'none' ? 0 : (taggedWidth ?? (hasFallback ? fallback : widths[key] ?? 0));
  return {
    presence,
    width,
    surface: tags[`${surfaceKey}:${side}:surface`] ?? tags[`${surfaceKey}:both:surface`] ?? tags[`${surfaceKey}:surface`] ?? null,
    source: taggedWidth ? 'tagged-width' : presence === 'explicit' ? 'tagged-presence' : presence,
  };
}

function parkingFacility(tags, side, fallback, widths) {
  const value = tags[`parking:${side}`] ?? tags[`parking:lane:${side}`] ??
    tags['parking:both'] ?? tags['parking:lane:both'] ?? tags.parking;
  const presence = facilityPresence(value, side, false);
  const taggedWidth = positiveNumber(tags[`parking:${side}:width`] ?? tags['parking:both:width'] ?? tags['parking:width']);
  return {
    presence,
    width: presence === 'none' ? 0 : (taggedWidth ?? (fallback > 0 ? fallback : widths.parking)),
    orientation: tags[`parking:${side}:orientation`] ?? tags['parking:both:orientation'] ?? 'parallel',
    source: taggedWidth ? 'tagged-width' : presence === 'explicit' ? 'tagged-presence' : 'none',
  };
}

function medianFacility(tags, fallback, widths, oneway) {
  const divider = tags.median ?? tags.divider;
  const physical = divider !== undefined && !ABSENT.has(String(divider).toLowerCase()) &&
    !['no', 'none', 'dashed_line', 'solid_line', 'line'].includes(String(divider).toLowerCase());
  const explicit = physical || String(tags.median).toLowerCase() === 'yes';
  const taggedWidth = positiveNumber(tags['median:width'] ?? tags['divider:width']);
  const present = !oneway && (explicit || fallback > 0);
  return {
    presence: present ? (explicit ? 'explicit' : 'fallback') : 'none',
    width: present ? (taggedWidth ?? (fallback > 0 ? fallback : widths.median)) : 0,
    source: taggedWidth ? 'tagged-width' : explicit ? 'tagged-presence' : present ? 'hierarchy-fallback' : 'none',
  };
}

/**
 * Derive a complete, symmetric-by-default road cross-section from retained OSM
 * tags. Each band records whether it was explicit or a documented fallback so
 * later renderers do not have to guess why a width exists.
 */
export function deriveRoadCrossSection(road, profile = loadRoadProfile()) {
  const tags = roadTags(road);
  const hw = tags.highway;
  if (!hw || profile.ignore.has(hw)) return null;
  const highwaySpec = profile.highway[hw];
  if (!highwaySpec) return null;

  let hierarchy = highwaySpec.hierarchy;
  if (hierarchy === 'service' && tags.service === 'alley') hierarchy = 'alley';
  const fallback = profile.crossSections[hierarchy];
  if (!fallback) throw new Error(`road hierarchy ${hierarchy} has no cross-section fallback`);

  const lanes = laneCount(tags, fallback.lanes, highwaySpec);
  const taggedWidth = positiveNumber(tags.width);
  const laneWidth = taggedWidth ? taggedWidth / lanes.total : fallback.laneWidth;
  const oneway = ['yes', '1', 'true', '-1'].includes(String(tags.oneway).toLowerCase());
  const median = medianFacility(tags, highwaySpec.median ?? fallback.median, profile.facilityWidths, oneway);
  const sides = {};
  for (const side of ['left', 'right']) {
    sides[side] = {
      shoulder: facility(tags, 'shoulder', side, fallback.shoulder, profile.facilityWidths),
      cycleway: facility(tags, 'cycleway', side, fallback.cycleway, profile.facilityWidths),
      parking: parkingFacility(tags, side, fallback.parking, profile.facilityWidths),
      sidewalk: facility(tags, 'sidewalk', side, fallback.sidewalk, profile.facilityWidths, {
        implicit: fallback.sidewalk === 'implicit',
      }),
    };
  }

  const coreWidth = taggedWidth ?? lanes.total * laneWidth;
  const internalWidth = coreWidth + median.width +
    sides.left.cycleway.width + sides.right.cycleway.width +
    sides.left.parking.width + sides.right.parking.width;
  const explicitSidewalkWidth = [sides.left.sidewalk, sides.right.sidewalk]
    .filter((part) => part.presence === 'explicit')
    .reduce((sum, part) => sum + part.width, 0);
  const explicitOuterWidth = internalWidth + sides.left.shoulder.width + sides.right.shoulder.width +
    explicitSidewalkWidth;
  const builtUpWidth = internalWidth + sides.left.shoulder.width + sides.right.shoulder.width +
    sides.left.sidewalk.width + sides.right.sidewalk.width;

  return {
    cls: highwaySpec.class,
    hierarchy,
    highway: hw,
    lanes: lanes.total,
    laneSource: lanes.source,
    laneWidth,
    surface: tags.surface ?? highwaySpec.surface ?? fallback.surface,
    surfaceSource: tags.surface ? 'surface' : 'hierarchy-fallback',
    oneway,
    coreWidth,
    carriagewayWidth: internalWidth,
    width: Math.max(1, Math.round(internalWidth)),
    explicitOuterWidth,
    builtUpWidth,
    median,
    sides,
  };
}

/** Backward-compatible classifier; now returns the complete cross-section. */
export function classifyRoad(road, profile = loadRoadProfile()) {
  return deriveRoadCrossSection(road, profile);
}

/**
 * All integer squares a segment passes through, as a stairstep.
 *
 * A supercover walk rather than Bresenham: Bresenham picks one square per step
 * and leaves diagonal gaps a survivor could walk through, which is fine for
 * drawing a line and wrong for laying a road.
 */
export function walkSegment(x0, y0, x1, y1) {
  const out = [];
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);

  const dx = Math.abs(ex - x);
  const dy = Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx - dy;

  for (let guard = 0; guard < 1e6; guard++) {
    out.push([x, y]);
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    // Step in both axes when the error straddles, adding the corner square so
    // the run is 8-connected rather than diagonal-gapped.
    if (e2 > -dy && e2 < dx) {
      err += dx - dy;
      x += sx;
      out.push([x, y]);
      y += sy;
      continue;
    }
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    } else {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/**
 * Is this stretch of centreline running close enough to 45° for the diagonal
 * kerb artwork to line up?
 */
export function isDiagonalRun(dx, dy, tolerance) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 1e-6 || ay < 1e-6) return false;
  const ratio = ax > ay ? ay / ax : ax / ay;
  return ratio >= 1 - tolerance;
}

/** Integer scan bounds for a rounded polyline band. */
export function polylineBounds(points, radius) {
  if (!points?.length) return { minX: 0, minY: 0, maxX: -1, maxY: -1 };
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    minX: Math.floor(Math.min(...xs) - radius),
    minY: Math.floor(Math.min(...ys) - radius),
    maxX: Math.ceil(Math.max(...xs) + radius),
    maxY: Math.ceil(Math.max(...ys) + radius),
  };
}

/**
 * Nearest point on a polyline, including cumulative position and local bearing.
 * The vector `toward` points from the sampled square back to the centreline and
 * therefore remains meaningful on rounded caps and bends.
 */
export function nearestPolylinePoint(points, x, y) {
  let best = null;
  let prefix = 0;
  for (let i = 1; i < (points?.length ?? 0); i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    const rawT = ((x - ax) * dx + (y - ay) * dy) / (length * length);
    const t = Math.max(0, Math.min(1, rawT));
    const px = ax + dx * t;
    const py = ay + dy * t;
    const towardX = px - x;
    const towardY = py - y;
    const distance = Math.hypot(towardX, towardY);
    const candidate = { distance, towardX, towardY, dx, dy, along: prefix + t * length, segment: i - 1, t };
    if (!best || distance < best.distance - 1e-9 ||
      (Math.abs(distance - best.distance) <= 1e-9 && candidate.along < best.along)) best = candidate;
    prefix += length;
  }
  return best;
}

/** Dominant cardinal direction of an arbitrary vector. */
export function cardinalFromVector(x, y) {
  if (Math.abs(x) >= Math.abs(y)) return x >= 0 ? 'east' : 'west';
  return y >= 0 ? 'south' : 'north';
}

/**
 * Select one member of a complete diagonal artwork cycle. Vanilla adjacency
 * evidence identifies offsets 0/3 as straight pieces and 1/2 as alternating
 * corners. Reversing the cycle on the opposite road edge keeps both facings
 * continuous rather than mirroring a single repeated sprite.
 */
export function selectCurbSequenceVariant(mapping, along, towardX, towardY) {
  const variants = mapping?.variants ?? [];
  if (!variants.length) return null;
  const step = Math.floor(along / Math.SQRT2 + 1e-6);
  const phase = ((step % variants.length) + variants.length) % variants.length;
  // Vanilla diagonal curb runs use a mirrored corner cadence rather than
  // ascending sheet order. The first four slots form a Gray-code cycle; the
  // remaining two complete the measured six-piece run used by Build 42.
  const forward = variants.length >= 6 ? [0, 1, 3, 2, 4, 5] : [0, 1, 3, 2];
  const reverse = variants.length >= 6 ? [0, 2, 3, 1, 5, 4] : [0, 2, 3, 1];
  const mirrored = towardX + towardY < 0 || (Math.abs(towardX + towardY) < 1e-9 && towardX > 0);
  const order = mirrored ? reverse : forward;
  return variants[order[phase] ?? phase]?.tile ?? null;
}

/** Which measured diagonal sheet half faces back toward this carriageway. */
export function diagonalCurbFacing(orientation, towardX, towardY) {
  const side = orientation === 'nw-se' ? towardY - towardX : towardY + towardX;
  return side < 0 ? 'b' : 'a';
}

const CURB_LAYERS = [FLOOR_FURNITURE, FLOOR_OVERLAY];
const CARDINAL_STEP = {
  north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0],
};

function squareKey(x, y) {
  return `${x},${y}`;
}

/**
 * Accumulate curb edges until every road has painted its carriageway. Deferring
 * this pass is what lets a later road punch a real junction/driveway opening
 * through an earlier road's curb instead of leaving furniture in the asphalt.
 */
export function createCurbPlan() {
  return {
    candidates: [],
    carriageway: new Set(),
    bridgeDeck: new Set(),
    bridgeEdge: new Set(),
    bridgeClearance: new Set(),
    bridges: [],
    openings: [],
    sidewalkCandidates: [],
    renderedSidewalks: new Set(),
    renderedCurbs: new Set(),
    vergeCandidates: [],
    buildingFootprint: new Set(),
    intersections: [],
  };
}

const ANGLE_EPSILON = 22.5;

function angleDegrees(a, b) {
  const dot = a.dx * b.dx + a.dy * b.dy;
  const lengths = Math.hypot(a.dx, a.dy) * Math.hypot(b.dx, b.dy);
  if (lengths < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / lengths))) * 180 / Math.PI;
}

function hasOppositePair(arms) {
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      if (angleDegrees(arms[i], arms[j]) >= 180 - ANGLE_EPSILON) return true;
    }
  }
  return false;
}

function oppositePairCount(arms) {
  let count = 0;
  const used = new Set();
  const pairs = [];
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const error = Math.abs(180 - angleDegrees(arms[i], arms[j]));
      if (error <= ANGLE_EPSILON) pairs.push({ i, j, error });
    }
  }
  pairs.sort((a, b) => a.error - b.error);
  for (const pair of pairs) {
    if (used.has(pair.i) || used.has(pair.j)) continue;
    used.add(pair.i);
    used.add(pair.j);
    count++;
  }
  return count;
}

/** Classify a normalized set of arms meeting at one road-network node. */
export function classifyIntersectionTopology(arms, { roundabout = false } = {}) {
  if (roundabout) return 'roundabout';
  if (arms.length <= 1) return 'dead-end';
  if (arms.length === 2) {
    const angle = angleDegrees(arms[0], arms[1]);
    if (angle >= 180 - ANGLE_EPSILON) return 'straight';
    if (angle <= 45) return 'merge';
    return 'bend';
  }
  const divided = arms.some((arm) => arm.divided) && arms.length >= 4;
  if (divided && oppositePairCount(arms) >= 2) return 'divided-crossing';
  if (arms.length === 3 && hasOppositePair(arms)) return 't-junction';
  if (arms.length === 4 && oppositePairCount(arms) >= 2) return 'four-way';
  return 'skewed-junction';
}

function nodeArm(node, other, road, spec) {
  return {
    dx: other[0] - node[0],
    dy: other[1] - node[1],
    width: spec.width,
    roadClass: spec.cls,
    hierarchy: spec.hierarchy,
    divided: (spec.median?.width ?? 0) > 0,
    road,
  };
}

/**
 * Build network-node topology from projected OSM ways. Every polyline vertex
 * contributes its incident directions, so bends and internal T/cross nodes are
 * treated exactly like shared way endpoints. Coincident duplicate arms are
 * collapsed (OSM commonly splits one logical road into multiple ways).
 */
export function buildIntersectionTopology(roads, profile = loadRoadProfile()) {
  const nodes = new Map();
  const add = (point, arm, roundabout) => {
    const key = squareKey(Math.round(point[0]), Math.round(point[1]));
    let node = nodes.get(key);
    if (!node) nodes.set(key, (node = { x: Math.round(point[0]), y: Math.round(point[1]), arms: [], roundabout: false }));
    node.roundabout ||= roundabout;
    if (Math.hypot(arm.dx, arm.dy) < 1e-9) return;
    const bearing = Math.atan2(arm.dy, arm.dx);
    const duplicate = node.arms.find((other) => {
      const delta = Math.abs(Math.atan2(Math.sin(bearing - other.bearing), Math.cos(bearing - other.bearing)));
      return delta < Math.PI / 36;
    });
    if (!duplicate) node.arms.push({ ...arm, bearing });
    else if (arm.width > duplicate.width) Object.assign(duplicate, arm, { bearing });
  };

  const roundabouts = [];
  for (const road of roads) {
    const spec = road.spec ?? classifyRoad(road, profile);
    if (!spec || (road.points?.length ?? 0) < 2) continue;
    const roundabout = String(roadTags(road).junction).toLowerCase() === 'roundabout';
    if (roundabout) {
      const unique = road.points.at(-1)?.[0] === road.points[0][0] && road.points.at(-1)?.[1] === road.points[0][1]
        ? road.points.slice(0, -1) : road.points;
      const x = unique.reduce((sum, point) => sum + point[0], 0) / unique.length;
      const y = unique.reduce((sum, point) => sum + point[1], 0) / unique.length;
      const radius = Math.max(...unique.map((point) => Math.hypot(point[0] - x, point[1] - y))) + spec.width / 2;
      roundabouts.push({
        x: Math.round(x), y: Math.round(y), radius, ringRadius: radius - spec.width / 2,
        roundabout: true, topology: 'roundabout',
        arms: [],
        ring: { width: spec.width, roadClass: spec.cls, hierarchy: spec.hierarchy, road },
      });
      continue;
    }
    for (let i = 0; i < road.points.length; i++) {
      const point = road.points[i];
      if (i > 0) add(point, nodeArm(point, road.points[i - 1], road, spec), false);
      if (i + 1 < road.points.length) add(point, nodeArm(point, road.points[i + 1], road, spec), false);
    }
  }

  for (const roundabout of roundabouts) {
    for (const [key, node] of nodes) {
      const dx = node.x - roundabout.x;
      const dy = node.y - roundabout.y;
      const distance = Math.hypot(dx, dy);
      const tolerance = Math.max(2, ...(node.arms.map((arm) => arm.width / 2)));
      if (Math.abs(distance - roundabout.ringRadius) > tolerance) continue;
      for (const arm of node.arms) {
        // At a ring connection, retain only arms pointing away from the centre;
        // the circular way itself was deliberately consolidated above.
        if (arm.dx * dx + arm.dy * dy <= 0) continue;
        roundabout.arms.push({ ...arm, dx, dy });
      }
      nodes.delete(key);
    }
    if (!roundabout.arms.length) {
      roundabout.arms.push({
        dx: 1, dy: 0,
        width: roundabout.ring.width,
        roadClass: roundabout.ring.roadClass,
        hierarchy: roundabout.ring.hierarchy,
        divided: false,
        road: roundabout.ring.road,
        synthetic: true,
      });
    }
  }

  return [...nodes.values()].map((node) => ({
    ...node,
    topology: classifyIntersectionTopology(node.arms, node),
    radius: Math.max(2, ...node.arms.map((arm) => arm.width / 2 + 1)),
  })).filter((node) => node.topology !== 'straight').concat(roundabouts);
}

const INTERSECTION_DESIGN = {
  'dead-end': { shape: 'cap', crossing: 'none', markings: 'terminate' },
  bend: { shape: 'rounded-bend', crossing: 'none', markings: 'suppress-conflict' },
  't-junction': { shape: 'tee', crossing: 'approach-mouth', markings: 'stop-at-conflict' },
  'four-way': { shape: 'cross', crossing: 'approach-mouth', markings: 'stop-at-conflict' },
  'skewed-junction': { shape: 'skewed', crossing: 'setback', markings: 'stop-at-conflict' },
  roundabout: { shape: 'annulus', crossing: 'setback', markings: 'yield-at-entry' },
  merge: { shape: 'taper', crossing: 'none', markings: 'merge-clear-zone' },
  'divided-crossing': { shape: 'divided-cross', crossing: 'median-refuge', markings: 'stop-at-conflict' },
};

function normalizedArm(arm) {
  const length = Math.hypot(arm.dx, arm.dy) || 1;
  return { ...arm, ux: arm.dx / length, uy: arm.dy / length };
}

function intersectionContains(intersection, arms, x, y, radius) {
  const dx = x - intersection.x;
  const dy = y - intersection.y;
  const distance = Math.hypot(dx, dy);
  if (intersection.topology === 'roundabout') return distance <= radius;
  const core = Math.max(1, Math.min(radius, ...arms.map((arm) => arm.width / 2)));
  if (distance <= core) return true;
  return arms.some((arm) => {
    const along = dx * arm.ux + dy * arm.uy;
    const lateral = Math.abs(dx * arm.uy - dy * arm.ux);
    return along >= 0 && along <= radius && lateral <= arm.width / 2;
  });
}

function crossingForArm(cx, cy, radius, arm, policy) {
  if (policy === 'none' || arm.hierarchy === 'highway' || arm.rural || arm.synthetic) return null;
  const setback = policy === 'setback' ? 2 : 1;
  const distance = radius + setback;
  const x = cx + arm.ux * distance;
  const y = cy + arm.uy * distance;
  const half = Math.max(1, arm.width / 2);
  return {
    policy,
    x: Math.round(x),
    y: Math.round(y),
    orientation: highwayMarkingOrientation(arm.uy, -arm.ux),
    from: [Math.round(x - arm.uy * half), Math.round(y + arm.ux * half)],
    to: [Math.round(x + arm.uy * half), Math.round(y - arm.ux * half)],
    refuge: policy === 'median-refuge' && arm.divided,
  };
}

function intersectionBoundary(plan, intersection, radius, inWorld, builtUp = () => true) {
  const roadAt = (x, y) => plan.carriageway.has(squareKey(x, y));
  const curbCorners = [];
  const sidewalkCorners = [];
  const localCurbs = new Set();
  const scan = Math.ceil(radius + 4);
  for (let y = intersection.y - scan; y <= intersection.y + scan; y++) {
    for (let x = intersection.x - scan; x <= intersection.x + scan; x++) {
      if (!inWorld(x, y) || roadAt(x, y)) continue;
      const toward = Object.entries(CARDINAL_STEP)
        .filter(([, [dx, dy]]) => roadAt(x + dx, y + dy))
        .map(([direction]) => direction);
      if (!toward.length) continue;
      const orientation = toward[0];
      const perpendicular = toward.length > 1 && !(
        (toward.includes('north') && toward.includes('south')) ||
        (toward.includes('east') && toward.includes('west'))
      );
      plan.candidates.push({
        x, y,
        along: Math.atan2(y - intersection.y, x - intersection.x) * radius,
        towardX: CARDINAL_STEP[orientation][0],
        towardY: CARDINAL_STEP[orientation][1],
        diagonal: false,
        roadClass: intersection.arms[0]?.roadClass ?? 'residential',
        orientation,
        forcedTopology: perpendicular ? 'corner' : 'straight',
        forcedCorner: perpendicular ? toward.slice(0, 2) : null,
        intersection: intersection.topology,
      });
      localCurbs.add(squareKey(x, y));
      if (perpendicular) curbCorners.push([x, y]);
    }
  }

  // A sidewalk follows one square outside the curb boundary. Keeping this as a
  // deferred candidate lets the completed mask select pavement corners/ends.
  for (let y = intersection.y - scan; y <= intersection.y + scan; y++) {
    for (let x = intersection.x - scan; x <= intersection.x + scan; x++) {
      if (!inWorld(x, y) || !builtUp(x, y) || roadAt(x, y) || localCurbs.has(squareKey(x, y))) continue;
      const nearCurb = Object.values(CARDINAL_STEP)
        .some(([dx, dy]) => localCurbs.has(squareKey(x + dx, y + dy)));
      if (!nearCurb) continue;
      plan.sidewalkCandidates.push({
        x, y, distance: radius + 2, outer: true, diagonal: false,
        side: 'intersection', sidewalk: 'implicit', surface: 'concrete',
        intersection: intersection.topology,
      });
      sidewalkCorners.push([x, y]);
    }
  }
  return { curbCorners, sidewalkCorners };
}

/**
 * Lay a stop bar across each approach mouth of a junction.
 *
 * `renderIntersections` already works out where every arm's mouth is and how
 * wide it is; nothing was drawing it. This runs after curbs so a bar is never
 * hidden under one, and only where the approach lies on a cardinal — the sheet
 * has no bar for a road arriving at 30 degrees and inventing one would be worse
 * than leaving the mouth plain.
 */
export function renderJunctionMarkings(canvas, plan, registry = loadSemanticRegistry()) {
  let painted = 0;
  for (const intersection of plan?.intersections ?? []) {
    for (const crossing of intersection.crossings ?? []) {
      const mapping = resolveSemantic(registry, 'road.marking.junction', {
        orientation: crossing.orientation,
      });
      if (!mapping?.variants.length) continue;
      const [fx, fy] = crossing.from;
      const [tx, ty] = crossing.to;
      const steps = Math.max(Math.abs(tx - fx), Math.abs(ty - fy));
      for (let i = 0; i <= steps; i++) {
        const t = steps ? i / steps : 0;
        const x = Math.round(fx + (tx - fx) * t);
        const y = Math.round(fy + (ty - fy) * t);
        const key = squareKey(x, y);
        // The bar belongs on the carriageway, never on a curb or a pavement.
        if (!plan.carriageway.has(key) || plan.renderedCurbs.has(key) ||
          plan.renderedSidewalks.has(key)) continue;
        painted += paintSemantic(canvas, mapping, `junction:stopline:${crossing.orientation}:${key}`,
          x, y, FLOOR_OVERLAY);
      }
    }
  }
  return painted;
}

/**
 * Author junction conflict areas after all individual ways have been painted.
 * Each topology gets an explicit geometry/traffic design. The union fill
 * removes notches; a deferred boundary supplies curb and sidewalk corners; and
 * crossing/marking approach records give the next artwork pass exact mouths
 * without allowing straight lines to leak through the conflict area.
 */
export function renderIntersections(canvas, intersections, plan, ctx = {}, registry = loadSemanticRegistry()) {
  const inWorld = ctx.inWorld ?? (() => true);
  let painted = 0;
  for (const intersection of intersections) {
    const { x: cx, y: cy, topology } = intersection;
    const design = INTERSECTION_DESIGN[topology];
    if (!design) throw new Error(`unsupported intersection topology ${topology}`);
    const arms = intersection.arms.map((source) => {
      const arm = normalizedArm(source);
      const spec = arm.road?.spec ?? (arm.hierarchy ? { hierarchy: arm.hierarchy } : null);
      return {
        ...arm,
        rural: Boolean(arm.road && spec && isRuralRoad(arm.road, spec, ctx)),
      };
    });
    const radius = intersection.radius + (topology === 'skewed-junction' ? 1 : 0);
    const primary = arms.reduce((best, arm) => !best || arm.width > best.width ? arm : best, null);
    const surface = resolveSemantic(registry, 'road.surface', { roadClass: primary?.roadClass ?? 'residential' });
    const island = topology === 'roundabout'
      ? resolveSemantic(registry, 'road.highway.band', { band: 'median' })
      : null;
    const islandRadius = topology === 'roundabout'
      ? Math.max(1, (intersection.ringRadius ?? radius * 0.75) - (intersection.ring?.width ?? primary?.width ?? 2) / 2)
      : 0;

    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if (!inWorld(x, y)) continue;
        const distance = Math.hypot(x - cx, y - cy);
        if (!intersectionContains(intersection, arms, x, y, radius)) continue;
        canvas.delete(x, y, FLOOR_OVERLAY);
        canvas.delete(x, y, FLOOR_FURNITURE);
        if (distance <= islandRadius && island?.variants.length) {
          painted += paintSemantic(canvas, island, `intersection:island:${x},${y}`, x, y, FLOOR);
          plan.carriageway.delete(squareKey(x, y));
        } else if (surface?.variants.length) {
          painted += paintSemantic(canvas, surface, `intersection:${topology}:${x},${y}`, x, y, FLOOR);
          plan.carriageway.add(squareKey(x, y));
        }
      }
    }

    markCurbOpening(plan, cx, cy, Math.max(1, radius - 1), 'junction');
    const urbanEdges = arms.some((arm) => !arm.rural && arm.hierarchy !== 'highway');
    const corners = urbanEdges
      ? intersectionBoundary(plan, { ...intersection, arms }, radius, inWorld, ctx.builtUp)
      : { curbCorners: [], sidewalkCorners: [] };
    const crossings = arms.map((arm) => crossingForArm(cx, cy, radius, arm, design.crossing)).filter(Boolean);
    for (const crossing of crossings) {
      const halfSpan = Math.max(1, Math.hypot(
        crossing.to[0] - crossing.from[0],
        crossing.to[1] - crossing.from[1],
      ) / 2);
      markCurbOpening(plan, crossing.x, crossing.y, halfSpan, 'crossing');
    }
    const markings = arms.filter((arm) => !arm.synthetic).map((arm) => ({
      policy: design.markings,
      x: Math.round(cx + arm.ux * (radius + 1)),
      y: Math.round(cy + arm.uy * (radius + 1)),
      orientation: highwayMarkingOrientation(arm.dx, arm.dy),
      suppressedInside: radius,
    }));
    plan.intersections.push({
      ...intersection, arms, radius, clearRadius: radius - 1,
      design, crossings, markings, ...corners,
    });
  }
  return painted;
}

export function markCurbOpening(plan, x, y, radius = 1, kind = 'transition') {
  if (!plan || !Number.isFinite(x) || !Number.isFinite(y)) return;
  plan.openings.push({ x: Math.round(x), y: Math.round(y), radius: Math.max(0, radius), kind });
}

function openingAt(plan, x, y) {
  return plan.openings.find((opening) =>
    Math.hypot(x - opening.x, y - opening.y) <= opening.radius + 1e-9) ?? null;
}

function inOpening(plan, x, y) {
  return Boolean(openingAt(plan, x, y));
}

const GRASS_EDGE_OFFSETS = {
  north: [8, 12], east: [10, 14], south: [11, 15], west: [9, 13],
};
const GRASS_INNER_CORNERS = {
  'north-east': 4, 'south-east': 2, 'south-west': 3, 'north-west': 1,
};

function deterministicIndex(key, length) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

function sidewalkTopology(x, y, occupied) {
  const neighbors = Object.entries(CARDINAL_STEP)
    .filter(([, [dx, dy]]) => occupied.has(squareKey(x + dx, y + dy)))
    .map(([direction]) => direction);
  if (!neighbors.length) return 'isolated';
  if (neighbors.length === 1) return 'end';
  if (neighbors.length === 2) {
    const opposite = (neighbors.includes('north') && neighbors.includes('south')) ||
      (neighbors.includes('east') && neighbors.includes('west'));
    return opposite ? 'straight' : 'outer-corner';
  }
  if (neighbors.length === 3) return 'inner-corner';
  return 'fill';
}

function grassBoundaryTile(x, y, occupied) {
  const exposed = Object.entries(CARDINAL_STEP)
    .filter(([, [dx, dy]]) => !occupied.has(squareKey(x + dx, y + dy)))
    .map(([direction]) => direction);
  if (!exposed.length) return null;
  for (const [corner, offset] of Object.entries(GRASS_INNER_CORNERS)) {
    const [a, b] = corner.split('-');
    if (exposed.includes(a) && exposed.includes(b)) return `blends_natural_01_${32 + offset}`;
  }
  const direction = exposed[0];
  const choices = GRASS_EDGE_OFFSETS[direction];
  return `blends_natural_01_${32 + choices[deterministicIndex(`${x},${y},${direction}`, choices.length)]}`;
}

/**
 * Paint sidewalk and soft-verge candidates only after every carriageway is
 * known. This prevents an earlier pavement from surviving under a crossing
 * road and gives ends, cuts, corners, and diagonal runs topology-aware keys.
 */
export function finalizeSidewalks(
  canvas, plan, registry = loadSemanticRegistry(), onProgress = () => {},
) {
  if (!plan?.sidewalkCandidates?.length) return 0;
  const bySquare = new Map();
  for (const candidate of plan.sidewalkCandidates) {
    const key = squareKey(candidate.x, candidate.y);
    if (plan.carriageway.has(key) || plan.buildingFootprint.has(key)) continue;
    const opening = openingAt(plan, candidate.x, candidate.y);
    if (opening && !['driveway', 'crossing', 'entrance'].includes(opening.kind)) continue;
    const previous = bySquare.get(key);
    if (!previous || candidate.distance < previous.distance) {
      bySquare.set(key, { ...candidate, transition: opening?.kind ?? null });
    }
  }
  const occupied = new Set(bySquare.keys());
  let painted = 0;
  let seen = 0;
  for (const [key, candidate] of [...bySquare].sort((a, b) =>
    a[1].y - b[1].y || a[1].x - b[1].x)) {
    if (++seen % 2000 === 0) onProgress(seen / bySquare.size);
    const topology = candidate.diagonal ? 'diagonal' : sidewalkTopology(candidate.x, candidate.y, occupied);
    const mapping = resolveSemantic(registry, 'road.sidewalk', {
      builtUp: true,
      sidewalk: candidate.sidewalk,
      surface: candidate.surface,
      topology,
      transition: candidate.transition,
    });
    const wrote = paintSemantic(canvas, mapping, `sidewalk:${candidate.surface}:${topology}:${key}`,
      candidate.x, candidate.y, FLOOR);
    painted += wrote;
    if (wrote) plan.renderedSidewalks.add(key);

    // Grass artwork feathers onto the outer pavement square. Suppress it at
    // driveway/crossing cuts, where a crisp accessible transition is intended.
    if (!candidate.transition && candidate.outer) {
      const overlay = grassBoundaryTile(candidate.x, candidate.y, occupied);
      if (overlay) {
        canvas.set(candidate.x, candidate.y, FLOOR_OVERLAY, overlay);
        painted++;
      }
    }
  }
  return painted;
}

function candidateTopology(candidate, bySquare) {
  const neighbors = [];
  for (const [direction, [dx, dy]] of Object.entries(CARDINAL_STEP)) {
    const adjacent = bySquare.get(squareKey(candidate.x + dx, candidate.y + dy)) ?? [];
    if (adjacent.some((other) => other.orientation === candidate.orientation || other.diagonal === candidate.diagonal)) {
      neighbors.push(direction);
    }
  }
  if (neighbors.length === 0) return 'isolated';
  if (neighbors.length === 1) return 'end';
  const opposite = (neighbors.includes('north') && neighbors.includes('south')) ||
    (neighbors.includes('east') && neighbors.includes('west'));
  return opposite ? 'straight' : 'corner';
}

function cornerOrientation(candidate, bySquare) {
  const directions = new Set(candidate.forcedCorner ?? [candidate.orientation]);
  for (const [dx, dy] of Object.values(CARDINAL_STEP)) {
    for (const other of bySquare.get(squareKey(candidate.x + dx, candidate.y + dy)) ?? []) {
      if (!other.diagonal) directions.add(other.orientation);
    }
  }
  for (const corner of ['north-east', 'south-east', 'south-west', 'north-west']) {
    const [a, b] = corner.split('-');
    if (directions.has(a) && directions.has(b)) return corner;
  }
  return candidate.orientation;
}

/**
 * Select curbs against the completed road mask. Candidates covered by another
 * carriageway or by an authored opening are removed. Remaining runs are
 * classified as straight, corner, end, isolated, or diagonal before artwork is
 * resolved, so a straight sprite is never silently used for a corner.
 */
export function finalizeCurbs(
  canvas, plan, registry = loadSemanticRegistry(), onProgress = () => {},
) {
  if (!plan) return 0;
  const survivors = plan.candidates.filter((candidate) =>
    !plan.carriageway.has(squareKey(candidate.x, candidate.y)) &&
    !inOpening(plan, candidate.x, candidate.y));
  const bySquare = new Map();
  for (const candidate of survivors) {
    const key = squareKey(candidate.x, candidate.y);
    if (!bySquare.has(key)) bySquare.set(key, []);
    bySquare.get(key).push(candidate);
  }

  let painted = 0;
  const occupied = new Set();
  let seen = 0;
  for (const candidate of survivors.sort((a, b) => a.y - b.y || a.x - b.x || a.along - b.along)) {
    // Reported as it goes: this is a minute of work on a city, and a minute of
    // an unchanging build screen is indistinguishable from a crash.
    if (++seen % 2000 === 0) onProgress(seen / survivors.length);
    const key = squareKey(candidate.x, candidate.y);
    if (occupied.has(key)) continue;
    const topology = candidate.diagonal
      ? 'diagonal'
      : (candidate.forcedTopology ?? candidateTopology(candidate, bySquare));
    const orientation = topology === 'corner'
      ? cornerOrientation(candidate, bySquare)
      : candidate.orientation;
    let curb = resolveSemantic(registry, 'road.curb', {
      roadClass: candidate.roadClass,
      topology,
      orientation,
      facing: candidate.diagonal
        ? diagonalCurbFacing(candidate.orientation, candidate.towardX, candidate.towardY)
        : undefined,
      intersectionBoundary: Boolean(candidate.intersection),
    });
    // Isolated one-square remnants use the measured directional termination
    // piece; they are not allowed to fall into unsupported junction mappings.
    if (!curb?.variants.length && topology === 'isolated') {
      curb = resolveSemantic(registry, 'road.curb', {
        roadClass: candidate.roadClass,
        topology: 'end',
        orientation: candidate.orientation,
      });
    }
    const tile = candidate.diagonal
      ? selectCurbSequenceVariant(curb, candidate.along, candidate.towardX, candidate.towardY)
      : selectSemanticVariant(curb, `${topology}:${key}`);
    if (!tile) continue;
    for (const layer of CURB_LAYERS) canvas.delete(candidate.x, candidate.y, layer);
    canvas.set(candidate.x, candidate.y, curb.layer ?? FLOOR_FURNITURE, tile);
    plan.renderedCurbs.add(key);
    occupied.add(key);
    painted++;
  }
  return painted;
}

/** Select and write one semantic tile, returning one when a tile was written. */
function paintSemantic(canvas, mapping, key, x, y, layer = mapping?.layer) {
  const tile = selectSemanticVariant(mapping, key);
  if (!tile) return 0;
  canvas.set(x, y, layer, tile);
  return 1;
}

function highwayMarkingOrientation(dx, dy) {
  return Math.abs(dx) >= Math.abs(dy) ? 'east-west' : 'north-south';
}

function markingsDisabled(road) {
  const tags = roadTags(road);
  const value = tags.markings ?? tags.lane_markings ?? tags['lane_markings:both'];
  return ABSENT.has(String(value).toLowerCase());
}

const LOOSE_SURFACES = new Set([
  'unpaved', 'compacted', 'fine_gravel', 'gravel', 'pebblestone',
  'dirt', 'earth', 'ground', 'mud', 'sand', 'grass',
]);
const DIRT_SURFACES = new Set(['dirt', 'earth', 'ground', 'mud', 'sand', 'grass']);

/** Reduce OSM's many surface values to artwork materials available to this renderer. */
export function ruralSurfaceMaterial(road, spec) {
  const tags = roadTags(road);
  const surface = String(tags.surface ?? spec.surface ?? '').toLowerCase();
  if (DIRT_SURFACES.has(surface)) return 'dirt';
  if (LOOSE_SURFACES.has(surface) || spec.hierarchy === 'track') return 'gravel';
  return 'paved';
}

/**
 * Decide whether a way belongs to the rural renderer. Functional hierarchy is
 * authoritative for tracks and unclassified rural roads. Other ordinary roads
 * use retained OSM settlement hints first and the placed-building mask second.
 */
export function isRuralRoad(road, spec, ctx) {
  if (!spec || spec.hierarchy === 'highway') return false;
  const tags = roadTags(road);
  const declared = String(tags.rural ?? tags.context ?? tags.zone ?? '').toLowerCase();
  if (['yes', 'rural', 'countryside'].includes(declared)) return true;
  if (['no', 'urban', 'residential', 'town', 'city'].includes(declared)) return false;
  if (spec.hierarchy === 'rural' || spec.hierarchy === 'track') return true;

  const landuse = String(tags.landuse ?? tags['abutters:landuse'] ?? tags.abutters ?? '').toLowerCase();
  if (['farmland', 'farmyard', 'forest', 'meadow', 'orchard'].includes(landuse)) return true;
  if (['residential', 'commercial', 'industrial', 'retail'].includes(landuse)) return false;
  if (String(tags.lit).toLowerCase() === 'no') return true;

  const builtUp = ctx.builtUp ?? (() => false);
  let urban = 0;
  let samples = 0;
  for (const [x, y] of road.points ?? []) {
    urban += builtUp(x, y) ? 1 : 0;
    samples++;
  }
  return samples === 0 || urban * 2 < samples;
}

function ruralMarkingsEnabled(road, spec, material, artwork) {
  if (material !== 'paved' || spec.lanes < 2 || markingsDisabled(road)) return false;
  const tags = roadTags(road);
  const tagged = tags.markings ?? tags.lane_markings ?? tags['lane_markings:both'];
  if (tagged !== undefined) return PRESENT.has(String(tagged).toLowerCase());
  return artwork.markedHierarchies.includes(spec.hierarchy);
}

/**
 * Whether a built-up street carries a centre line.
 *
 * Vanilla is not uniform about this and neither is the real world: Muldraugh
 * paints its through routes and leaves the residential grid plain. Marking every
 * street would be as wrong as marking none, so the same hierarchy list the rural
 * renderer uses decides it, and an explicit OSM tag still wins either way.
 */
/**
 * Is the centre line unbroken?
 *
 * Vanilla's two-lane roads carry a continuous yellow line, and so do the American
 * roads they are drawn from. A repeating dash also fell apart off the grid axes:
 * consecutive squares of a diagonal run advance along the centreline by √2, so an
 * integer repeat skipped values and the line came out ragged rather than dashed.
 */
function continuousCentreLine(artwork) {
  return artwork?.centreLineContinuous !== false;
}

function urbanMarkingsEnabled(road, spec, profile = loadRoadProfile()) {
  if (spec.lanes < 2 || markingsDisabled(road)) return false;
  const tags = roadTags(road);
  const tagged = tags.markings ?? tags.lane_markings ?? tags['lane_markings:both'];
  if (tagged !== undefined) return PRESENT.has(String(tagged).toLowerCase());
  if (LOOSE_SURFACES.has(String(tags.surface ?? '').toLowerCase())) return false;
  return (profile.ruralArtwork?.markedHierarchies ?? []).includes(spec.hierarchy);
}

/**
 * Paint a rural cross-section: narrow material-aware carriageway, optional
 * aggregate shoulders, shallow ditch ground and a grassy verge. No curb or
 * sidewalk semantic is resolved here, so sparse rural OSM can never acquire
 * automatic urban edges.
 */
export function paintRuralRoad(canvas, road, spec, ctx, profile = loadRoadProfile(), registry = null) {
  const inWorld = ctx.inWorld ?? (() => true);
  registry ??= ctx.semanticRegistry ?? loadSemanticRegistry();
  const artwork = profile.ruralArtwork;
  const material = ruralSurfaceMaterial(road, spec);
  const surface = resolveSemantic(registry, 'road.rural.surface', { material });
  const shoulder = resolveSemantic(registry, 'road.rural.band', { band: 'shoulder' });
  const ditch = resolveSemantic(registry, 'road.rural.band', { band: 'ditch' });
  const verge = resolveSemantic(registry, 'road.rural.band', { band: 'verge' });
  if (!surface) return 0;

  const tags = roadTags(road);
  const ditchTagged = tags.ditch ?? tags.drainage;
  const ditchDenied = ABSENT.has(String(ditchTagged).toLowerCase());
  const ditchRequested = ['yes', 'ditch', 'open'].includes(String(ditchTagged).toLowerCase());
  const defaultDitch = material === 'paved' && ['arterial', 'collector', 'rural'].includes(spec.hierarchy);
  const ditchWidth = !ditchDenied && (ditchRequested || defaultDitch) ? artwork.ditch : 0;
  const leftShoulder = spec.sides?.left?.shoulder?.width ?? 0;
  const rightShoulder = spec.sides?.right?.shoulder?.width ?? 0;
  const carriageHalf = spec.width / 2;
  const marks = ruralMarkingsEnabled(road, spec, material, artwork);
  const onBand = ctx.onBand ?? null;
  const maxOut = carriageHalf + Math.max(leftShoulder, rightShoulder) + ditchWidth + artwork.verge;
  // Odd-width roads are centred on a square; even-width roads straddle it.
  const phase = spec.width % 2 === 0 ? 0.5 : 0;
  let painted = 0;

  forEachNearPolyline(road.points, maxOut + phase, (sample) => {
    const { x, y } = sample;
    if (sample.beyondEnd || !inWorld(x, y)) return;
    const lateral = sample.side * sample.distance + phase;
    const distance = Math.abs(lateral);
    const sideShoulder = lateral < 0 ? leftShoulder : rightShoulder;

    let mapping = null;
    let band = null;
    if (distance < carriageHalf) {
      mapping = surface;
      band = 'carriageway';
    } else if (distance < carriageHalf + sideShoulder) {
      mapping = shoulder;
      band = 'shoulder';
    } else if (distance < carriageHalf + sideShoulder + ditchWidth) {
      mapping = ditch;
      band = 'ditch';
    } else if (distance < carriageHalf + sideShoulder + ditchWidth + artwork.verge) {
      mapping = verge;
      band = 'verge';
    }
    if (!mapping) return;
    painted += paintSemantic(canvas, mapping, `rural:${material}:${band}:${x},${y}`, x, y, FLOOR);
    onBand?.({ ...sample, band, renderer: 'rural', material, spec, road });

    if (!marks || band !== 'carriageway') return;
    // The centre line rides the square the centreline itself passes through —
    // lateral index zero, whichever phase the width chose. Deriving it from the
    // same coordinate as the bands keeps the line on the road at any bearing
    // rather than only on the two grid axes.
    if (Math.round(sample.side * sample.distance) !== 0) return;
    if (!continuousCentreLine(artwork) &&
      Math.floor(sample.along) % artwork.markingPeriod >= artwork.markingLength) return;
    const orientation = highwayMarkingOrientation(sample.dx, sample.dy);
    const marking = resolveSemantic(registry, 'road.marking.centre', {
      orientation,
      topology: 'straight',
    });
    if (!marking?.variants.length) return;
    painted += paintSemantic(canvas, marking, `rural:marking:${orientation}:${x},${y}`,
      x, y, FLOOR_OVERLAY);
    onBand?.({ ...sample, band: 'marking', renderer: 'rural', material, spec, road });
  });
  return painted;
}

/**
 * Paint a limited-access road as a cross-section instead of passing it through
 * the urban kerb/sidewalk painter. The centre band is a physical median when
 * one was derived; asphalt carriageways, shoulders, and soft verges stack on
 * each side. Using a half-square lateral coordinate gives even-width bands an
 * exact and deterministic number of raster squares.
 */
export function paintHighway(canvas, road, spec, ctx, profile = loadRoadProfile(), registry = null) {
  const inWorld = ctx.inWorld ?? (() => true);
  registry ??= ctx.semanticRegistry ?? loadSemanticRegistry();
  const surface = resolveSemantic(registry, 'road.surface', { roadClass: spec.cls });
  const shoulder = resolveSemantic(registry, 'road.highway.band', { band: 'shoulder' });
  const median = resolveSemantic(registry, 'road.highway.band', { band: 'median' });
  const verge = resolveSemantic(registry, 'road.highway.band', { band: 'verge' });
  if (!surface) return 0;

  const artwork = profile.highwayArtwork;
  const medianWidth = spec.median?.width ?? 0;
  const medianHalf = medianWidth / 2;
  const carriageHalf = spec.coreWidth / 2;
  const leftShoulder = spec.sides?.left?.shoulder?.width ?? 0;
  const rightShoulder = spec.sides?.right?.shoulder?.width ?? 0;
  const maxOut = medianHalf + carriageHalf + Math.max(leftShoulder, rightShoulder) + artwork.verge;
  const noMarkings = markingsDisabled(road);
  const onBand = ctx.onBand ?? null;
  let painted = 0;

  // Which lateral indices carry a line, and whether that line is dashed. A
  // highway's edge lines are continuous and its lane separators repeat, which is
  // the difference a player reads at a glance between a motorway and a street.
  const lines = new Map();
  if (!noMarkings) {
    const outer = medianHalf + carriageHalf - artwork.edgeLineInset;
    const add = (value, dashed) => {
      const index = Math.round(value - 0.5);
      if (!lines.has(index) || !dashed) lines.set(index, dashed);
    };
    add(-outer, false);
    add(outer, false);
    if (medianWidth > 0) {
      const lanesPerSide = Math.max(1, Math.round(spec.lanes / 2));
      for (let lane = 1; lane < lanesPerSide; lane++) {
        const fromMedian = lane * (carriageHalf / lanesPerSide);
        add(-(medianHalf + fromMedian), true);
        add(medianHalf + fromMedian, true);
      }
    } else {
      for (let lane = 1; lane < spec.lanes; lane++) {
        add(-carriageHalf + lane * spec.laneWidth, true);
      }
    }
  }

  // The half-square phase shifts every band outward on one side, so the search
  // radius has to admit a square whose centre is half a square further out than
  // the widest band. Without it the outer verge loses its right-hand row.
  forEachNearPolyline(road.points, maxOut + 0.5, (sample) => {
    const { x, y } = sample;
    // A limited-access road is one of a chain of OSM ways. A rounded cap of
    // verge past a terminus would be painted over the next way's carriageway
    // whenever the two are painted in that order, so the ends are square.
    if (sample.beyondEnd || !inWorld(x, y)) return;
    // Even-width bands straddle the centreline, which is what puts the median on
    // two squares rather than three. The half-square phase is the whole reason
    // `test/highway-rendering.test.js` can pin an exact column.
    const lateral = sample.side * sample.distance + 0.5;
    const distance = Math.abs(lateral);
    const sideShoulder = lateral < 0 ? leftShoulder : rightShoulder;

    let mapping = null;
    let band = null;
    if (medianWidth > 0 && distance <= medianHalf) {
      mapping = median;
      band = 'median';
    } else if (distance <= medianHalf + carriageHalf) {
      mapping = surface;
      band = 'carriageway';
    } else if (distance <= medianHalf + carriageHalf + sideShoulder) {
      mapping = shoulder;
      band = 'shoulder';
    } else if (distance <= medianHalf + carriageHalf + sideShoulder + artwork.verge) {
      mapping = verge;
      band = 'verge';
    }
    if (!mapping) return;
    painted += paintSemantic(canvas, mapping, `highway:${band}:${x},${y}`, x, y, FLOOR);
    onBand?.({ ...sample, band, renderer: 'highway', spec, road });

    if (!lines.size || band !== 'carriageway') return;
    const dashed = lines.get(Math.round(lateral - 0.5));
    if (dashed === undefined) return;
    if (dashed && Math.floor(sample.along) % artwork.markingPeriod >= artwork.markingLength) return;
    const orientation = highwayMarkingOrientation(sample.dx, sample.dy);
    const marking = resolveSemantic(registry, 'road.highway.marking', { orientation });
    if (!marking?.variants.length) return;
    painted += paintSemantic(canvas, marking, `highway:marking:${orientation}:${x},${y}`,
      x, y, FLOOR_OVERLAY);
    onBand?.({ ...sample, band: 'marking', renderer: 'highway', spec, road });
  });

  return painted;
}

function bridgeTagValue(road) {
  return String(roadTags(road).bridge ?? '').trim().toLowerCase();
}

/** Whether retained OSM semantics identify this way as an elevated road span. */
export function isBridgeRoad(road) {
  const value = bridgeTagValue(road);
  return value !== '' && !ABSENT.has(value);
}

function integerTag(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Derive structure data separately from the ordinary cross-section. OSM bridge
 * ways normally begin and end at the abutments, so their complete projected
 * polyline is the deck extent. Layer is retained to make overlap ownership
 * explicit even though the current four-layer prefab format cannot model two
 * independently walkable z-level roads on one square.
 */
export function deriveBridgeStructure(road, spec, profile = loadRoadProfile()) {
  if (!isBridgeRoad(road) || (road.points?.length ?? 0) < 2) return null;
  const tags = roadTags(road);
  const artwork = profile.bridgeArtwork ?? {};
  const layer = integerTag(tags.layer, 1);
  const deckWidth = Math.max(1, spec.width + (artwork.deckOverhang ?? 0));
  const barrierValue = String(tags.barrier ?? tags['bridge:barrier'] ?? '').toLowerCase();
  const barriers = !ABSENT.has(barrierValue) && tags.barrier !== 'no' &&
    String(tags['bridge:barrier']).toLowerCase() !== 'no';
  const length = polylineLength(road.points);
  return {
    bridge: bridgeTagValue(road),
    layer,
    deckWidth,
    barriers,
    length,
    approachLength: Math.min(artwork.approachLength ?? 3, Math.max(0, length / 3)),
    supportsRepresentable: false,
    supportReason: 'The four-layer ground prefab has no independent elevated support/z-level representation.',
  };
}

/**
 * Paint an elevated deck with hard edges instead of terrain verges, ditches,
 * urban curbs, or sidewalks. Barrier sprites are conservative measured curb
 * pieces: they are representable as continuous floor furniture, whereas piers
 * below an elevated deck are deliberately retained only as structure metadata.
 */
export function paintBridge(canvas, road, spec, ctx, profile = loadRoadProfile(), registry = null) {
  const structure = deriveBridgeStructure(road, spec, profile);
  if (!structure) return 0;
  const inWorld = ctx.inWorld ?? (() => true);
  const plan = ctx.curbPlan ?? createCurbPlan();
  registry ??= ctx.semanticRegistry ?? loadSemanticRegistry();
  const deck = resolveSemantic(registry, 'road.bridge.deck', {
    material: String(roadTags(road).surface ?? spec.surface ?? 'asphalt').toLowerCase(),
    roadClass: spec.cls,
  }) ?? resolveSemantic(registry, 'road.surface', { roadClass: spec.cls });
  const edge = resolveSemantic(registry, 'road.bridge.edge', { material: 'concrete' });
  const half = structure.deckWidth / 2;
  const onBand = ctx.onBand ?? null;
  let painted = 0;

  forEachNearPolyline(road.points, half + 0.5, (nearest) => {
    const { x, y } = nearest;
    if (!inWorld(x, y)) return;
    const key = squareKey(x, y);
    plan.bridgeClearance.add(key);
    plan.renderedCurbs.delete(key);
    plan.renderedSidewalks.delete(key);
    // The deck owns every authored ground/edge layer in its footprint. This
    // removes terrain blends, ordinary curbs, and stale markings at overlaps.
    canvas.delete(x, y, FLOOR_OVERLAY);
    canvas.delete(x, y, FLOOR_FURNITURE);
    if (nearest.distance <= half) {
      painted += paintSemantic(canvas, deck, `bridge:deck:${x},${y}`, x, y, FLOOR);
      plan.bridgeEdge.delete(key);
      plan.bridgeDeck.add(key);
      plan.carriageway.add(key);
      onBand?.({ ...nearest, band: 'bridge-deck', renderer: 'bridge', spec, road });
    } else if (edge?.variants.length && !plan.bridgeDeck.has(key)) {
      painted += paintSemantic(canvas, edge, `bridge:edge:${x},${y}`, x, y, FLOOR);
      plan.bridgeEdge.add(key);
      onBand?.({ ...nearest, band: 'bridge-edge', renderer: 'bridge', spec, road });
    }
  });

  const tags = roadTags(road);
  const noMarkings = markingsDisabled(road);
  let alongOffset = 0;
  for (let i = 1; i < road.points.length; i++) {
    const [ax, ay] = road.points[i - 1];
    const [bx, by] = road.points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length < 0.5) continue;
    const nx = -dy / length;
    const ny = dx / length;
    const walk = walkSegment(ax, ay, bx, by);
    const orientation = highwayMarkingOrientation(dx, dy);
    const marking = resolveSemantic(registry,
      spec.hierarchy === 'highway' ? 'road.highway.marking' : 'road.marking.centre',
      spec.hierarchy === 'highway' ? { orientation } : { orientation, topology: 'straight' });

    for (let step = 0; step < walk.length; step++) {
      const [cx, cy] = walk[step];
      const along = alongOffset + step;
      const fromEnd = structure.length - along;
      const onApproach = along < structure.approachLength || fromEnd < structure.approachLength;
      if (!noMarkings && spec.lanes >= 2 && marking?.variants.length &&
          along % (profile.bridgeArtwork?.markingPeriod ?? 6) < (profile.bridgeArtwork?.markingLength ?? 4)) {
        painted += paintSemantic(canvas, marking, `bridge:marking:${orientation}:${cx},${cy}`,
          cx, cy, FLOOR_OVERLAY);
      }
      if (!structure.barriers || onApproach) continue;
      for (const side of [-1, 1]) {
        const offset = side * (half + 0.35);
        const x = Math.round(cx + nx * offset);
        const y = Math.round(cy + ny * offset);
        if (!inWorld(x, y)) continue;
        const facing = cardinalTowardRoad(nx, ny, offset);
        const barrier = resolveSemantic(registry, 'road.bridge.barrier', { orientation: facing }) ??
          resolveSemantic(registry, 'road.curb', { roadClass: spec.cls, topology: 'straight', orientation: facing });
        painted += paintSemantic(canvas, barrier, `bridge:barrier:${facing}:${x},${y}`,
          x, y, FLOOR_FURNITURE);
      }
    }
    alongOffset += walk.length - 1;
  }

  // Clear ordinary edge facilities through each abutment and taper their
  // return over the configured approach instead of ending in the deck.
  const approachRadius = half + structure.approachLength;
  for (const endpoint of [road.points[0], road.points.at(-1)]) {
    markCurbOpening(plan, endpoint[0], endpoint[1], approachRadius, 'bridge-approach');
  }
  plan.bridges.push({ ...structure, points: road.points.map((point) => [...point]), highway: tags.highway });
  return painted;
}

/**
 * Paint one road onto the canvas.
 *
 * @param {import('./grid.js').TileCanvas} canvas
 * @param {{points: [number,number][]}} road  centreline in world squares
 * @param {{cls: string, width: number}} spec
 * @param {{builtUp: (x:number,y:number)=>boolean, inWorld?: (x:number,y:number)=>boolean}} ctx
 */
export function paintRoad(canvas, road, spec, ctx, profile = loadRoadProfile()) {
  // A road is clipped with a vertex of slack on each side so it still reaches
  // the map edge, and its bands stack outward from the centreline, so it can
  // round to a square just outside the world. Project Zomboid indexes cells
  // from zero and has nowhere to put a negative one.
  const inWorld = ctx.inWorld ?? (() => true);
  const registry = ctx.semanticRegistry ?? loadSemanticRegistry();
  const curbPlan = ctx.curbPlan ?? createCurbPlan();
  const ownsCurbPlan = !ctx.curbPlan;

  // Every renderer contributes its paved footprint. This deliberately happens
  // even for rural roads and motorways: they receive no default curbs, but a
  // ramp, lane, or driveway crossing an urban edge must terminate that curb.
  const footprintRadius = spec.hierarchy === 'highway'
    ? (spec.median?.width ?? 0) / 2 + spec.coreWidth / 2 +
      Math.max(spec.sides?.left?.shoulder?.width ?? 0, spec.sides?.right?.shoulder?.width ?? 0)
    : spec.width / 2;
  forEachNearPolyline(road.points, footprintRadius, ({ x, y }) => {
    if (inWorld(x, y)) curbPlan.carriageway.add(squareKey(x, y));
  });

  if (isBridgeRoad(road)) {
    return paintBridge(canvas, road, spec, { ...ctx, curbPlan, semanticRegistry: registry }, profile, registry);
  }
  if (spec.hierarchy === 'highway') {
    return paintHighway(canvas, road, spec, ctx, profile, registry);
  }
  if (isRuralRoad(road, spec, ctx)) {
    return paintRuralRoad(canvas, road, spec, ctx, profile, registry);
  }
  const roadSurface = resolveSemantic(registry, 'road.surface', { roadClass: spec.cls });
  if (!roadSurface) return 0;

  const bands = profile.bands;
  const half = spec.width / 2;
  const wantsSidewalk = ['left', 'right'].some(
    (side) => spec.sides?.[side]?.sidewalk?.presence !== 'none',
  );

  let painted = 0;
  const pts = road.points;
  const sidewalkWidth = Math.max(
    bands.sidewalk,
    spec.sides?.left?.sidewalk?.width ?? 0,
    spec.sides?.right?.sidewalk?.width ?? 0,
  );
  const maxOut = half + bands.kerb + (wantsSidewalk ? sidewalkWidth + bands.verge : 0);
  const curbSquares = [];
  const onBand = ctx.onBand ?? null;
  const marks = urbanMarkingsEnabled(road, spec);
  const artwork = profile.ruralArtwork ?? {};
  const centreLineHere = continuousCentreLine(artwork)
    ? () => true
    : (along) => Math.floor(along) % (artwork.markingPeriod ?? 10) < (artwork.markingLength ?? 5);

  // Rasterise the complete polyline rather than stamping each segment. Distance
  // to the nearest segment naturally gives rounded, overlap-free joins and
  // retains the source bearing at every angle.
  forEachNearPolyline(pts, maxOut, (nearest) => {
    const { x, y } = nearest;
    if (!inWorld(x, y)) return;

    if (nearest.distance <= half) {
      const tile = selectSemanticVariant(roadSurface, `${x},${y}`);
      if (tile) {
        canvas.set(x, y, FLOOR, tile);
        painted++;
        onBand?.({ ...nearest, band: 'carriageway', renderer: 'urban', spec, road });
      }
      // A two-lane street carries a centre line the same way a rural road does.
      // Vanilla Muldraugh marks its through streets and leaves the residential
      // grid plain, which is what `urbanMarkingsEnabled` reproduces.
      if (marks && Math.round(nearest.side * nearest.distance) === 0 && centreLineHere(nearest.along)) {
        const orientation = highwayMarkingOrientation(nearest.dx, nearest.dy);
        const marking = resolveSemantic(registry, 'road.marking.centre', {
          orientation,
          topology: 'straight',
        });
        if (marking?.variants.length) {
          painted += paintSemantic(canvas, marking, `urban:marking:${orientation}:${x},${y}`,
            x, y, FLOOR_OVERLAY);
          onBand?.({ ...nearest, band: 'marking', renderer: 'urban', spec, road });
        }
      }
      return;
    }
    if (nearest.distance <= half + bands.kerb) {
      curbSquares.push({ x, y, ...nearest });
      onBand?.({ ...nearest, band: 'kerb', renderer: 'urban', spec, road });
      return;
    }
    if (!wantsSidewalk || !ctx.builtUp(x, y)) return;
    const side = nearest.side < 0 ? 'left' : 'right';
    const facility = spec.sides?.[side]?.sidewalk;
    if (!facility || facility.presence === 'none') return;
    const width = Math.max(1, facility.width || bands.sidewalk);
    const outerDistance = half + bands.kerb + width;
    if (nearest.distance > outerDistance) return;
    const surface = String(facility.surface ?? roadTags(road)['sidewalk:surface'] ?? 'concrete').toLowerCase();
    curbPlan.sidewalkCandidates.push({
      x, y,
      distance: nearest.distance,
      outer: nearest.distance > outerDistance - 1,
      diagonal: isDiagonalRun(nearest.dx, nearest.dy, profile.diagonalTolerance),
      side,
      sidewalk: road.tags?.sidewalk ?? road.sidewalk ?? 'implicit',
      surface,
    });
    onBand?.({ ...nearest, band: 'sidewalk', renderer: 'urban', spec, road, surface });
  });

  // Save geometry rather than painting immediately. A shared plan is finalized
  // after every road, when junction mouths and crossing carriageways are known.
  for (const edge of curbSquares) {
    const { x, y, dx, dy, towardX, towardY, along } = edge;
    const diagonal = isDiagonalRun(dx, dy, profile.diagonalTolerance);
    curbPlan.candidates.push({
      x, y, along, towardX, towardY, diagonal,
      roadClass: spec.cls,
      orientation: diagonal
        ? (dx * dy >= 0 ? 'nw-se' : 'ne-sw')
        : cardinalFromVector(towardX, towardY),
    });
  }

  // Point semantics carried directly on a way open its curb on both sides.
  // Project-level OSM crossing objects are added to the same plan by buildPlan.
  const tags = roadTags(road);
  if (tags.crossing || tags.highway === 'crossing') {
    const crossingRadius = half + bands.kerb + (wantsSidewalk ? sidewalkWidth : 0);
    for (const [x, y] of road.points) markCurbOpening(curbPlan, x, y, crossingRadius, 'crossing');
  }
  if (tags.service === 'driveway') {
    for (const endpoint of [road.points[0], road.points.at(-1)]) {
      if (endpoint) markCurbOpening(curbPlan, endpoint[0], endpoint[1], Math.max(1, half), 'driveway');
    }
  }

  if (ownsCurbPlan) {
    painted += finalizeSidewalks(canvas, curbPlan, registry);
    painted += finalizeCurbs(canvas, curbPlan, registry);
  }
  return painted;
}

/** Cardinal direction from an edge square back toward its carriageway. */
export function cardinalTowardRoad(nx, ny, offset) {
  const sign = offset < 0 ? -1 : 1;
  const x = -nx * sign;
  const y = -ny * sign;
  if (Math.abs(x) >= Math.abs(y)) return x >= 0 ? 'east' : 'west';
  return y >= 0 ? 'south' : 'north';
}
