import {
  loadSemanticRegistry,
  resolveSemantic,
  selectSemanticVariant,
} from '../catalogue/semantic-registry.js';
import { hashString } from '../lib/rng.js';
import { FURNITURE } from '../prefab/layers.js';
import { cardinalFromVector, nearestPolylinePoint } from './roads.js';

const CONTROL_RANK = new Map([
  ['traffic_signals', 5],
  ['stop', 4],
  ['give_way', 3],
  ['crossing', 2],
  ['route', 1],
]);

const HIERARCHY_RANK = new Map([
  ['highway', 6], ['arterial', 5], ['collector', 4], ['rural', 3],
  ['residential', 2], ['service', 1], ['alley', 0], ['track', 0],
]);

function squareKey(x, y) {
  return `${x},${y}`;
}

function featurePoint(feature) {
  const point = feature?.points?.[0];
  return point && Number.isFinite(point[0]) && Number.isFinite(point[1]) ? point : null;
}

function roadTags(road) {
  return { ...road, ...(road?.tags ?? {}) };
}

function trafficSignValue(tags) {
  return String(tags.traffic_sign ?? tags['traffic_sign:forward'] ?? tags['traffic_sign:backward'] ?? '')
    .toLowerCase();
}

/** Reduce retained OSM point semantics to artwork classes supported by the registry. */
export function classifyRoadsideFeature(feature) {
  const tags = feature?.tags ?? {};
  const sign = trafficSignValue(tags);
  if (feature?.kind === 'signals' || tags.highway === 'traffic_signals') return 'traffic_signals';
  if (feature?.kind === 'crossing' || tags.highway === 'crossing') return 'crossing';
  if (tags.highway === 'stop' || /(?:^|[;,:])(?:stop|us:r1-1)(?:$|[;,:])/.test(sign)) return 'stop';
  if (tags.highway === 'give_way' || /(?:give_way|yield|us:r1-2)/.test(sign)) return 'give_way';
  if (tags.highway === 'motorway_junction' || tags.destination || tags.ref || tags.route) return 'route';
  if (tags.highway === 'street_lamp' || feature?.kind === 'street-furniture') return 'street_lamp';
  if (tags.barrier === 'bollard') return 'bollard';
  if (feature?.kind === 'sign' || sign) return 'regulatory';
  return null;
}

function nearestRoad(roads, x, y, maxDistance = 24) {
  let best = null;
  for (const road of roads ?? []) {
    const nearest = nearestPolylinePoint(road.points, x, y);
    if (!nearest || nearest.distance > maxDistance) continue;
    if (!best || nearest.distance < best.nearest.distance - 1e-9 ||
      (Math.abs(nearest.distance - best.nearest.distance) <= 1e-9 && String(road.fid) < String(best.road.fid))) {
      best = { road, nearest };
    }
  }
  return best;
}

function normalized(x, y) {
  const length = Math.hypot(x, y) || 1;
  return [x / length, y / length];
}

function placementSide(tags, key) {
  const direction = String(tags['traffic_sign:direction'] ?? tags.direction ?? '').toLowerCase();
  if (direction === 'left') return -1;
  if (direction === 'right') return 1;
  return (hashString(`roadside-side:${key}`) & 1) ? 1 : -1;
}

function facingForApproach(dx, dy, tags = {}) {
  const direction = String(tags.direction ?? tags['traffic_sign:direction'] ?? '').toLowerCase();
  if (['north', 'east', 'south', 'west'].includes(direction)) return direction;
  // A forward-moving driver approaches from behind the way vector; a backward
  // driver approaches from ahead. Facing names where the readable sign face
  // points, not the vehicle's travel direction.
  const sign = direction === 'backward' ? 1 : -1;
  return cardinalFromVector(dx * sign, dy * sign);
}

function clearCandidate(candidate, occupied, carriageway, buildingFootprint, inWorld) {
  const key = squareKey(candidate.x, candidate.y);
  return inWorld(candidate.x, candidate.y) && !occupied.has(key) &&
    !carriageway.has(key) && !buildingFootprint.has(key);
}

/**
 * Move a point semantic from its OSM node (usually the road centreline) to the
 * verge/outer sidewalk. The outward search is the safety invariant: furniture
 * is never accepted on the completed carriageway mask.
 */
function roadsideCandidate(x, y, road, nearest, side, occupied, plan, inWorld) {
  const [nx, ny] = normalized(-nearest.dy * side, nearest.dx * side);
  const half = Math.max(1, (road.spec?.width ?? 2) / 2);
  const start = Math.ceil(half + 1);
  for (let offset = start; offset <= start + 6; offset++) {
    const candidate = { x: Math.round(x + nx * offset), y: Math.round(y + ny * offset) };
    if (clearCandidate(candidate, occupied, plan.carriageway, plan.buildingFootprint, inWorld)) return candidate;
  }
  return null;
}

function makePlacement(kind, source, candidate, road, nearest, inferred = false, extra = {}) {
  const tags = source?.tags ?? {};
  const facing = extra.facing ?? facingForApproach(nearest.dx, nearest.dy, tags);
  return {
    kind,
    x: candidate.x,
    y: candidate.y,
    facing,
    orientation: Math.abs(nearest.dx) >= Math.abs(nearest.dy) ? 'east-west' : 'north-south',
    source: inferred ? 'inferred' : 'osm',
    sourceFid: source?.fid ?? null,
    roadFid: road?.fid ?? null,
    roadName: road?.name ?? road?.tags?.name ?? null,
    routeRef: tags.ref ?? road?.tags?.ref ?? null,
    inferred,
    ...extra,
  };
}

function explicitPlacements(objects, roads, plan, occupied, inWorld) {
  const placements = [];
  const ordered = [...(objects ?? [])].sort((a, b) => String(a.fid).localeCompare(String(b.fid)));
  for (const object of ordered) {
    const point = featurePoint(object);
    const kind = classifyRoadsideFeature(object);
    if (!point || !kind) continue;
    // No validated bollard face currently exists. Retain it in sourceFeatures,
    // but never substitute an unrelated pole merely to make the tag visible.
    if (kind === 'bollard') continue;
    const match = nearestRoad(roads, point[0], point[1]);
    if (!match) continue;
    const side = placementSide(object.tags ?? {}, object.fid ?? `${point[0]},${point[1]}`);
    const candidate = roadsideCandidate(point[0], point[1], match.road, match.nearest, side, occupied, plan, inWorld);
    if (!candidate) continue;
    const placement = makePlacement(kind, object, candidate, match.road, match.nearest);
    occupied.add(squareKey(candidate.x, candidate.y));
    placements.push(placement);
  }
  return placements;
}

function oppositeArm(arm, arms) {
  return arms.some((other) => other !== arm &&
    (arm.dx * other.dx + arm.dy * other.dy) /
      ((Math.hypot(arm.dx, arm.dy) || 1) * (Math.hypot(other.dx, other.dy) || 1)) < -0.9);
}

function inferredControlArms(intersection) {
  const arms = intersection.arms ?? [];
  if (intersection.topology === 'roundabout') return arms.map((arm) => ({ arm, kind: 'give_way' }));
  if (intersection.topology !== 't-junction') return [];
  const branch = arms.filter((arm) => !oppositeArm(arm, arms));
  if (branch.length !== 1) return [];
  const branchRank = HIERARCHY_RANK.get(branch[0].hierarchy) ?? 0;
  const throughRank = Math.max(...arms.filter((arm) => arm !== branch[0]).map((arm) =>
    HIERARCHY_RANK.get(arm.hierarchy) ?? 0));
  // Equal local streets are intentionally left uncontrolled. Inference is only
  // made when the terminating arm is functionally lower than the through road.
  return branchRank < throughRank ? [{ arm: branch[0], kind: 'stop' }] : [];
}

function hasNearbyExplicitControl(intersection, explicit) {
  return explicit.some((placement) => (CONTROL_RANK.get(placement.kind) ?? 0) >= 3 &&
    Math.hypot(placement.x - intersection.x, placement.y - intersection.y) <= intersection.radius + 10);
}

function routeWayPlacements(roads, plan, occupied, inWorld) {
  const placements = [];
  for (const road of [...(roads ?? [])].sort((a, b) => String(a.fid).localeCompare(String(b.fid)))) {
    const tags = roadTags(road);
    if (!(tags.ref || tags.route || tags.destination)) continue;
    if (!['highway', 'arterial', 'collector', 'rural'].includes(road.spec?.hierarchy)) continue;
    if ((road.points?.length ?? 0) < 2) continue;
    const segment = Math.floor((road.points.length - 1) / 2);
    const a = road.points[segment];
    const b = road.points[segment + 1];
    const x = (a[0] + b[0]) / 2;
    const y = (a[1] + b[1]) / 2;
    const nearest = { dx: b[0] - a[0], dy: b[1] - a[1] };
    const side = placementSide(tags, `route:${road.fid}`);
    const candidate = roadsideCandidate(x, y, road, nearest, side, occupied, plan, inWorld);
    if (!candidate) continue;
    const placement = makePlacement('route', road, candidate, road, nearest, false, {
      routeRef: tags.ref ?? tags.route ?? tags.destination,
    });
    occupied.add(squareKey(candidate.x, candidate.y));
    placements.push(placement);
  }
  return placements;
}

function inferredPlacements(intersections, explicit, plan, occupied, inWorld) {
  const placements = [];
  const ordered = [...(intersections ?? [])].sort((a, b) => a.y - b.y || a.x - b.x || a.topology.localeCompare(b.topology));
  for (const intersection of ordered) {
    if (hasNearbyExplicitControl(intersection, explicit)) continue;
    for (const { arm, kind } of inferredControlArms(intersection)) {
      if (arm.synthetic || arm.hierarchy === 'highway') continue;
      const [ux, uy] = normalized(arm.dx, arm.dy);
      const nearest = { dx: arm.dx, dy: arm.dy };
      const road = arm.road ?? { fid: null, spec: { width: arm.width }, tags: {} };
      const baseX = intersection.x + ux * (intersection.radius + 2);
      const baseY = intersection.y + uy * (intersection.radius + 2);
      const side = (hashString(`junction-control:${intersection.x},${intersection.y}:${kind}:${arm.dx},${arm.dy}`) & 1) ? 1 : -1;
      const candidate = roadsideCandidate(baseX, baseY, road, nearest, side, occupied, plan, inWorld);
      if (!candidate) continue;
      const placement = makePlacement(kind, null, candidate, road, nearest, true, {
        facing: cardinalFromVector(arm.dx, arm.dy),
        junction: intersection.topology,
      });
      occupied.add(squareKey(candidate.x, candidate.y));
      placements.push(placement);
    }
  }
  return placements;
}

function streetNamePlacements(intersections, plan, occupied, inWorld) {
  const placements = [];
  for (const intersection of [...(intersections ?? [])].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (!['t-junction', 'four-way', 'skewed-junction', 'divided-crossing'].includes(intersection.topology)) continue;
    const names = [...new Set((intersection.arms ?? []).map((arm) => arm.road?.tags?.name ?? arm.road?.name).filter(Boolean))].sort();
    if (names.length < 2) continue;
    const candidates = [
      [intersection.x + intersection.radius + 2, intersection.y + intersection.radius + 2],
      [intersection.x - intersection.radius - 2, intersection.y + intersection.radius + 2],
      [intersection.x + intersection.radius + 2, intersection.y - intersection.radius - 2],
      [intersection.x - intersection.radius - 2, intersection.y - intersection.radius - 2],
    ];
    const point = candidates.map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) }))
      .find((candidate) => clearCandidate(candidate, occupied, plan.carriageway, plan.buildingFootprint, inWorld));
    if (!point) continue;
    occupied.add(squareKey(point.x, point.y));
    placements.push({
      kind: 'street_name', x: point.x, y: point.y,
      facing: 'south', orientation: 'east-west', source: 'osm', inferred: false,
      streetNames: names.slice(0, 2), junction: intersection.topology,
      sourceFid: null, roadFid: null,
    });
  }
  return placements;
}

/** Build deterministic, lane-safe street-sign and supported-furniture records. */
export function planRoadsideFeatures({ objects = [], roads = [], intersections = [], curbPlan, inWorld = () => true }) {
  const occupied = new Set();
  const explicit = explicitPlacements(objects, roads, curbPlan, occupied, inWorld);
  const routeWays = routeWayPlacements(roads, curbPlan, occupied, inWorld);
  const inferred = inferredPlacements(intersections, explicit, curbPlan, occupied, inWorld);
  const streetNames = streetNamePlacements(intersections, curbPlan, occupied, inWorld);
  const placements = [...explicit, ...routeWays, ...inferred, ...streetNames]
    .sort((a, b) => a.y - b.y || a.x - b.x || a.kind.localeCompare(b.kind));
  return {
    placements,
    stats: {
      total: placements.length,
      osm: placements.filter((placement) => placement.source === 'osm').length,
      inferred: placements.filter((placement) => placement.inferred).length,
      byKind: Object.fromEntries([...new Set(placements.map((placement) => placement.kind))].sort()
        .map((kind) => [kind, placements.filter((placement) => placement.kind === kind).length])),
    },
  };
}

/** Paint planned records after curbs/sidewalks so no road pass can overwrite them. */
export function renderRoadsideFeatures(canvas, roadside, registry = loadSemanticRegistry()) {
  let painted = 0;
  for (const placement of roadside?.placements ?? []) {
    const semantic = placement.kind === 'street_lamp' ? 'object.furniture' : 'object.sign';
    const mapping = resolveSemantic(registry, semantic, {
      kind: placement.kind,
      facing: placement.facing,
      orientation: placement.orientation,
      inferred: placement.inferred,
      route: Boolean(placement.routeRef),
    });
    const tile = selectSemanticVariant(mapping, `roadside:${placement.kind}:${placement.x},${placement.y}:${placement.sourceFid ?? 'inferred'}`);
    if (!tile) continue;
    canvas.set(placement.x, placement.y, mapping.layer ?? FURNITURE, tile);
    placement.tile = tile;
    placement.layer = mapping.layer ?? FURNITURE;
    painted++;
  }
  return painted;
}
