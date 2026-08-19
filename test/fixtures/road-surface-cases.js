import {
  classifyRoad,
  createCurbPlan,
  finalizeCurbs,
  finalizeSidewalks,
  loadRoadProfile,
  markCurbOpening,
  paintRoad,
  renderIntersections,
} from '../../src/plan/roads.js';
import { TileCanvas } from '../../src/plan/grid.js';
import { terrainFields } from '../../src/plan/terrain-fields.js';

export const GOLDEN_SCHEMA = 1;
export const CENTRE = [48, 48];
export const ROAD_CLASSES = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
  'unclassified', 'living_street', 'service', 'track', 'footway', 'path',
  'pedestrian', 'cycleway', 'steps',
];
export const INTERSECTION_TYPES = [
  'dead-end', 'straight', 'bend', 'merge', 't-junction', 'four-way',
  'skewed-junction', 'divided-crossing', 'roundabout',
];

const profile = loadRoadProfile();
const inWorld = (x, y) => x >= 0 && y >= 0 && x < 96 && y < 96;

function road(highway, points, tags = {}) {
  const value = { highway, tags: { highway, context: 'urban', ...tags }, points };
  return { ...value, spec: classifyRoad(value, profile) };
}

function renderRoads(roads, { openings = [] } = {}) {
  const canvas = new TileCanvas();
  const curbPlan = createCurbPlan();
  const ctx = { inWorld, builtUp: () => true, curbPlan };
  for (const value of roads) paintRoad(canvas, value, value.spec, ctx, profile);
  for (const opening of openings) markCurbOpening(curbPlan, ...opening);
  finalizeSidewalks(canvas, curbPlan);
  finalizeCurbs(canvas, curbPlan);
  return canvas;
}

function unitArm(dx, dy, extra = {}) {
  const length = Math.hypot(dx, dy) || 1;
  return {
    dx, dy, ux: dx / length, uy: dy / length, width: 6,
    roadClass: 'residential', hierarchy: 'residential', ...extra,
  };
}

export function intersectionArms(type) {
  switch (type) {
    case 'dead-end': return [unitArm(1, 0)];
    case 'straight': return [unitArm(-1, 0), unitArm(1, 0)];
    case 'bend': return [unitArm(-1, 0), unitArm(0, 1)];
    case 'merge': return [unitArm(-1, -0.2), unitArm(-1, 0.2)];
    case 't-junction': return [unitArm(-1, 0), unitArm(1, 0), unitArm(0, 1)];
    case 'four-way': return [unitArm(-1, 0), unitArm(1, 0), unitArm(0, -1), unitArm(0, 1)];
    case 'skewed-junction': return [unitArm(-1, 0), unitArm(1, 0), unitArm(-0.4, -1), unitArm(0.2, 1), unitArm(1, 1)];
    case 'divided-crossing': return [unitArm(-1, 0, { divided: true }), unitArm(1, 0), unitArm(0, -1), unitArm(0, 1)];
    case 'roundabout': return [unitArm(1, 0)];
    default: throw new Error(`unknown intersection fixture ${type}`);
  }
}

function renderIntersection(type, arms = intersectionArms(type)) {
  // Straight-through degree-two nodes are deliberately omitted by
  // buildIntersectionTopology, so exercise their real rendering path as one
  // continuous road rather than sending an unsupported node to the junction pass.
  if (type === 'straight') {
    return renderRoads([road('residential', [[24, 48], [72, 48]], { sidewalk: 'both' })]);
  }
  const canvas = new TileCanvas();
  const plan = createCurbPlan();
  renderIntersections(canvas, [{
    x: CENTRE[0], y: CENTRE[1], topology: type,
    radius: type === 'roundabout' ? 8 : 5, arms,
  }], plan, { inWorld });
  finalizeSidewalks(canvas, plan);
  finalizeCurbs(canvas, plan);
  return canvas;
}

const BEARINGS = [
  ['e', [24, 0]], ['se', [24, 24]], ['s', [0, 24]], ['sw', [-24, 24]],
  ['w', [-24, 0]], ['nw', [-24, -24]], ['n', [0, -24]], ['ne', [24, -24]],
];

/** Every case is independently renderable and has stable absolute coordinates. */
export function goldenRasterCases() {
  const cases = [];
  for (const highway of ROAD_CLASSES) {
    const tags = highway === 'service' ? { service: 'alley' } : {};
    cases.push({
      id: `class/${highway}`,
      canvas: renderRoads([road(highway, [[30, 48], [66, 48]], tags)]),
    });
  }
  for (const [name, [dx, dy]] of BEARINGS) {
    cases.push({
      id: `bearing/${name}`,
      canvas: renderRoads([road('residential', [CENTRE, [48 + dx, 48 + dy]], { sidewalk: 'both' })]),
    });
  }
  const bends = [
    ['es', [[24, 48], [48, 48], [48, 72]]],
    ['sw', [[48, 24], [48, 48], [24, 48]]],
    ['wn', [[72, 48], [48, 48], [48, 24]]],
    ['ne', [[48, 72], [48, 48], [72, 48]]],
    ['diagonal', [[24, 24], [48, 48], [72, 24]]],
  ];
  for (const [name, points] of bends) {
    cases.push({ id: `bend/${name}`, canvas: renderRoads([road('residential', points, { sidewalk: 'both' })]) });
  }
  const urbanHorizontal = road('residential', [[24, 48], [72, 48]], { sidewalk: 'both' });
  cases.push({ id: 'curb/cardinal-horizontal', canvas: renderRoads([urbanHorizontal]) });
  cases.push({
    id: 'curb/cardinal-vertical',
    canvas: renderRoads([road('residential', [[48, 24], [48, 72]], { sidewalk: 'both' })]),
  });
  cases.push({
    id: 'curb/diagonal-nw-se',
    canvas: renderRoads([road('residential', [[24, 24], [72, 72]], { sidewalk: 'both' })]),
  });
  cases.push({
    id: 'curb/diagonal-ne-sw',
    canvas: renderRoads([road('residential', [[72, 24], [24, 72]], { sidewalk: 'both' })]),
  });
  cases.push({
    id: 'curb/opening-crossing',
    canvas: renderRoads([urbanHorizontal], { openings: [[48, 44, 2, 'crossing']] }),
  });
  cases.push({
    id: 'curb/opening-driveway',
    canvas: renderRoads([urbanHorizontal], { openings: [[56, 52, 2, 'driveway']] }),
  });
  cases.push({ id: 'sidewalk/straight-concrete', canvas: renderRoads([urbanHorizontal]) });
  cases.push({
    id: 'sidewalk/bend-corners-and-ends',
    canvas: renderRoads([road('residential', [[24, 48], [48, 48], [48, 72]], { sidewalk: 'both' })]),
  });
  cases.push({
    id: 'sidewalk/diagonal-edge',
    canvas: renderRoads([road('residential', [[24, 24], [72, 72]], { sidewalk: 'both' })]),
  });
  cases.push({
    id: 'sidewalk/one-sided-cut',
    canvas: renderRoads([
      road('residential', [[24, 48], [72, 48]], { sidewalk: 'left', 'sidewalk:left:surface': 'paving_stones' }),
    ], { openings: [[48, 44, 2, 'crossing']] }),
  });
  cases.push({
    id: 'sidewalk/driveway-and-crossing-cuts',
    canvas: renderRoads([urbanHorizontal], {
      openings: [[40, 44, 2, 'driveway'], [60, 52, 2, 'crossing']],
    }),
  });
  cases.push({
    id: 'sidewalk/gravel-surface',
    canvas: renderRoads([road('residential', [[24, 48], [72, 48]], {
      sidewalk: 'both', 'sidewalk:surface': 'gravel',
    })]),
  });
  for (const type of INTERSECTION_TYPES) {
    cases.push({ id: `intersection/${type}`, canvas: renderIntersection(type) });
  }
  cases.push({
    id: 'marking/highway-dashed-and-edge',
    canvas: renderRoads([road('motorway', [[18, 48], [78, 48]], { lanes: '4' })]),
  });
  cases.push({
    id: 'marking/rural-centre',
    canvas: renderRoads([road('primary', [[18, 48], [78, 48]], { context: 'rural', markings: 'yes' })]),
  });
  cases.push({
    id: 'marking/explicit-none',
    canvas: renderRoads([road('motorway', [[18, 48], [78, 48]], { markings: 'no' })]),
  });
  cases.push({
    id: 'bridge/straight-with-approaches',
    canvas: renderRoads([road('primary', [[20, 48], [76, 48]], { bridge: 'yes', layer: '1', 'bridge:barrier': 'yes' })]),
  });
  return cases;
}

export function canonicalCanvas(canvas) {
  return [...canvas.entries()]
    .map(({ x, y, layers }) => [x, y, Object.fromEntries(Object.entries(layers).sort(([a], [b]) => a.localeCompare(b)))])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

export function rasterGoldenDocument() {
  return {
    schema: GOLDEN_SCHEMA,
    cases: Object.fromEntries(goldenRasterCases().map(({ id, canvas }) => [id, canonicalCanvas(canvas)])),
  };
}

export function terrainBoundaryGolden() {
  const fields = terrainFields('golden-boundaries-v1');
  const boundaries = [-256, 0, 8, 256, 512];
  const names = ['grass', 'dirt', 'vegetation', 'moisture', 'wear', 'patch'];
  const samples = [];
  for (const boundary of boundaries) {
    for (const axis of ['x', 'y']) {
      for (const offset of [-1, 0, 1]) {
        for (const name of names) {
          const x = axis === 'x' ? boundary + offset : 17;
          const y = axis === 'y' ? boundary + offset : 17;
          samples.push([name, x, y, fields.at(name, x, y)]);
        }
      }
    }
  }
  return { seed: 'golden-boundaries-v1', samples };
}

export function transformPoint([x, y], transform, centre = CENTRE) {
  const dx = x - centre[0];
  const dy = y - centre[1];
  switch (transform) {
    case 'rotate90': return [centre[0] - dy, centre[1] + dx];
    case 'rotate180': return [centre[0] - dx, centre[1] - dy];
    case 'rotate270': return [centre[0] + dy, centre[1] - dx];
    case 'reflectX': return [centre[0] - dx, centre[1] + dy];
    case 'reflectY': return [centre[0] + dx, centre[1] - dy];
    default: throw new Error(`unknown fixture transform ${transform}`);
  }
}

export function topologyMask(canvas) {
  return [...canvas.entries()]
    .map(({ x, y, layers }) => [x, y, Object.keys(layers).sort()])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

export function transformedMask(canvas, transform) {
  return topologyMask(canvas).map(([x, y, layers]) => {
    const [tx, ty] = transformPoint([x, y], transform);
    return [tx, ty, layers];
  }).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

export function renderTransformFixture(kind, transform) {
  if (kind === 'road') {
    const points = [[24, 48], [48, 48], [48, 72]].map((point) => transformPoint(point, transform));
    return renderRoads([road('residential', points, { sidewalk: 'both' })]);
  }
  const type = kind === 'intersection' ? 't-junction' : kind.replace(/^intersection\//, '');
  if (type === 'straight') {
    const points = [[24, 48], [72, 48]].map((point) => transformPoint(point, transform));
    return renderRoads([road('residential', points, { sidewalk: 'both' })]);
  }
  const arms = intersectionArms(type).map((arm) => {
    const endpoint = transformPoint([CENTRE[0] + arm.dx, CENTRE[1] + arm.dy], transform);
    return unitArm(endpoint[0] - CENTRE[0], endpoint[1] - CENTRE[1], {
      divided: arm.divided,
      synthetic: arm.synthetic,
    });
  });
  return renderIntersection(type, arms);
}

export function baseTransformFixture(kind) {
  if (kind === 'road') {
    return renderRoads([road('residential', [[24, 48], [48, 48], [48, 72]], { sidewalk: 'both' })]);
  }
  const type = kind === 'intersection' ? 't-junction' : kind.replace(/^intersection\//, '');
  return renderIntersection(type);
}
