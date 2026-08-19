import assert from 'node:assert/strict';
import test from 'node:test';

import { buildQuery, checkRadius, normalise } from '../src/sources/osm.js';
import { projectAll } from '../src/emit/generate.js';

const bbox = { south: 38, west: -85, north: 39, east: -84 };

function line(tags, id = 1) {
  return {
    type: 'way',
    id,
    tags,
    geometry: [{ lon: -84.6, lat: 38.4 }, { lon: -84.5, lat: 38.5 }],
  };
}

test('Overpass query requests required semantics with bounded selectors', () => {
  const query = buildQuery(bbox, 42);

  assert.match(query, /^\[out:json\]\[timeout:42\]/);
  assert.match(query, /way\["highway"~"\^\(motorway\|motorway_link\|/);
  assert.match(query, /residential\|unclassified\|living_street\|service\|track/);
  assert.match(query, /footway\|path\|pedestrian\|cycleway\|steps\)\$"\]/);
  assert.match(query, /node\["highway"~/);
  assert.match(query, /node\["traffic_sign"\]/);
  assert.match(query, /node\["barrier"~"\^\(bollard\|block\|/);
  assert.match(query, /relation\["landuse"~/);
  assert.match(query, /way\["landcover"~"\^\(trees\|grass\|/);
  assert.match(query, /way\["waterway"~"\^\(river\|stream\|canal\|drain\|ditch\)\$"\]/);
  assert.match(query, /nwr\["amenity"~/);
  assert.match(query, /nwr\["shop"~/);
  assert.match(query, /out geom\(38,-85,39,-84\);/);

  // Payload growth is bounded by explicit value allow-lists. Never fetch all
  // nodes, all POIs, or recursively emit every node referenced by every way.
  assert.doesNotMatch(query, /node\([^)]/);
  assert.doesNotMatch(query, /nwr\["amenity"\]\(/);
  assert.doesNotMatch(query, />\s*;/);
  assert.doesNotMatch(query, /out body|out skel/);
});

test('normalise retains the complete bounded road rendering schema', () => {
  const roadTags = {
    highway: 'primary', lanes: '4', 'lanes:forward': '2', 'lanes:backward': '2',
    'turn:lanes': 'left|through|through|right', oneway: '-1', surface: 'asphalt',
    smoothness: 'bad', tracktype: 'grade2', 'surface:condition': 'worn', condition: 'poor',
    lane_markings: 'yes', centre_marking: 'solid', divider: 'line',
    sidewalk: 'both', 'sidewalk:left': 'separate', crossing: 'marked',
    'crossing:markings': 'zebra', 'crossing:signals': 'yes', junction: 'roundabout',
    bridge: 'yes', 'bridge:structure': 'beam', layer: '1',
    'parking:lane:left': 'parallel', traffic_sign: 'US:R1-1', lit: 'yes',
    name: 'Main Street', source: 'survey', 'tiger:reviewed': 'no',
  };
  const out = normalise({ elements: [line(roadTags)] });

  assert.equal(out.roads.length, 1);
  const road = out.roads[0];
  assert.equal(road.highway, 'primary');
  assert.equal(road.lanes, 4);
  assert.equal(road.oneway, true);
  for (const key of [
    'lanes:forward', 'lanes:backward', 'turn:lanes', 'surface', 'smoothness',
    'surface:condition', 'condition', 'lane_markings', 'centre_marking', 'divider',
    'sidewalk', 'sidewalk:left', 'crossing', 'crossing:markings', 'crossing:signals',
    'junction', 'bridge', 'bridge:structure', 'layer', 'parking:lane:left',
    'traffic_sign', 'lit',
  ]) {
    assert.equal(road.tags[key], roadTags[key], `${key} should survive normalization`);
  }
  assert.equal(road.tags.source, undefined);
  assert.equal(road.tags['tiger:reviewed'], undefined);
  assert.ok(Object.keys(road.tags).length < 50, 'tag schema must remain finite');
});

test('normalise preserves crossings, signs, barriers, land cover, parking and relevant POIs', () => {
  const elements = [
    { type: 'node', id: 1, lat: 38.45, lon: -84.55, tags: {
      highway: 'crossing', crossing: 'marked', 'crossing:markings': 'zebra', kerb: 'lowered',
    } },
    { type: 'node', id: 2, lat: 38.46, lon: -84.56, tags: {
      traffic_sign: 'US:R1-1', direction: '90', name: 'Stop sign',
    } },
    { type: 'node', id: 3, lat: 38.47, lon: -84.57, tags: { barrier: 'bollard', access: 'no' } },
    line({ landuse: 'forest', leaf_type: 'broadleaved', species: 'Quercus alba' }, 4),
    line({ amenity: 'parking', parking: 'surface', surface: 'asphalt' }, 5),
    { type: 'node', id: 6, lat: 38.48, lon: -84.58, tags: {
      amenity: 'hospital', name: 'County Hospital', phone: '+1 555 0100',
    } },
    line({ shop: 'supermarket', name: 'Market' }, 7),
  ];

  const out = normalise({ elements });
  assert.deepEqual(out.objects.map((item) => item.kind), ['crossing', 'sign', 'barrier']);
  assert.ok(out.objects.every((item) => item.geometry === 'point'));
  assert.equal(out.objects[0].tags['crossing:markings'], 'zebra');
  assert.equal(out.objects[1].tags.direction, '90');
  assert.equal(out.ground.length, 2);
  assert.equal(out.ground.find((item) => item.tags.amenity === 'parking').tags.parking, 'surface');
  assert.equal(out.ground.find((item) => item.tags.landuse === 'forest').tags.species, 'Quercus alba');
  assert.equal(out.pois.length, 2);
  assert.equal(out.pois[0].geometry, 'point');
  assert.equal(out.pois[0].tags.phone, undefined);
  assert.equal(out.pois[1].geometry, 'line');
});

test('normalise retains directional cross-sections, modern parking, sign and bridge details', () => {
  const roadTags = {
    highway: 'tertiary_link', service: 'driveway', lanes: '3',
    'lanes:forward': '2', 'lanes:backward': '1', 'lanes:both_ways': '1',
    'turn:lanes:forward': 'left|through', 'turn:lanes:backward': 'through',
    placement: 'right_of:1', 'placement:forward': 'middle_of:1', width: '10',
    lane_markings: 'yes', 'lane_markings:forward': 'yes', 'marking:centre': 'solid_line',
    'change:lanes:forward': 'no|yes', shoulder: 'both', 'shoulder:surface': 'gravel',
    'shoulder:left:width': '1', 'cycleway:right': 'lane', 'cycleway:right:width': '2',
    'cycleway:right:surface': 'asphalt', median: 'yes', 'median:width': '1.5',
    sidewalk: 'both', 'sidewalk:surface': 'concrete', 'sidewalk:left:width': '1.5',
    crossing: 'marked', 'crossing:island': 'yes', 'kerb:left': 'lowered',
    bridge: 'yes', covered: 'no', tunnel: 'no',
    traffic_sign: 'US:R1-1', 'traffic_sign:forward': 'US:R2-1', destination: 'Downtown',
    'parking:left': 'lane', 'parking:left:orientation': 'parallel', 'parking:left:width': '2.4', capacity: '20',
    source: 'survey', note: 'discard me',
  };
  const road = normalise({ elements: [line(roadTags)] }).roads[0];

  for (const [key, value] of Object.entries(roadTags)) {
    if (key === 'source' || key === 'note') assert.equal(road.tags[key], undefined);
    else assert.equal(road.tags[key], value, `${key} should survive normalization`);
  }
});

test('normalise retains added junction, landcover and configured POI semantics', () => {
  const out = normalise({ elements: [
    { type: 'node', id: 20, lat: 38.45, lon: -84.55, tags: {
      highway: 'motorway_junction', ref: '12', destination: 'Downtown',
    } },
    line({ landcover: 'trees', leaf_type: 'mixed', surface: 'ground' }, 21),
    { type: 'node', id: 22, lat: 38.46, lon: -84.56, tags: {
      amenity: 'courthouse', name: 'County Court',
    } },
    { type: 'node', id: 23, lat: 38.47, lon: -84.57, tags: {
      shop: 'doityourself', name: 'Hardware Store',
    } },
  ] });

  assert.equal(out.objects[0].kind, 'junction');
  assert.equal(out.objects[0].tags.destination, 'Downtown');
  assert.equal(out.ground[0].tags.landcover, 'trees');
  assert.deepEqual(out.pois.map((poi) => poi.tags.name), ['County Court', 'Hardware Store']);
});

test('normalise stitches relation outer members and does not fill inner rings', () => {
  const relation = {
    type: 'relation',
    id: 10,
    tags: { type: 'multipolygon', natural: 'water', name: 'Lake' },
    members: [
      { type: 'way', role: 'outer', geometry: [
        { lon: -84.6, lat: 38.4 }, { lon: -84.5, lat: 38.4 },
      ] },
      { type: 'way', role: 'outer', geometry: [
        { lon: -84.5, lat: 38.5 }, { lon: -84.6, lat: 38.5 }, { lon: -84.6, lat: 38.4 },
      ] },
      { type: 'way', role: 'outer', geometry: [
        { lon: -84.5, lat: 38.4 }, { lon: -84.5, lat: 38.5 },
      ] },
      { type: 'way', role: 'inner', geometry: [
        { lon: -84.57, lat: 38.43 }, { lon: -84.53, lat: 38.43 },
        { lon: -84.53, lat: 38.47 }, { lon: -84.57, lat: 38.43 },
      ] },
    ],
  };
  const out = normalise({ elements: [relation] });

  assert.equal(out.ground.length, 1);
  assert.deepEqual(out.ground[0].points[0], out.ground[0].points.at(-1));
  assert.equal(out.ground[0].points.length, 5);
  assert.equal(out.ground[0].tags.type, undefined);
});

test('projected authored plan input carries semantic objects and POIs', () => {
  const features = normalise({ elements: [
    line({ highway: 'residential', lanes: '2', sidewalk: 'both' }),
    line({ highway: 'tertiary_link', lanes: '1', 'lanes:forward': '1',
      'parking:right': 'lane', bridge: 'yes' }, 8),
    line({ leisure: 'playground', surface: 'sand' }, 2),
    { type: 'node', lat: 38.45, lon: -84.55, tags: { highway: 'traffic_signals' } },
    { type: 'node', lat: 38.46, lon: -84.56, tags: { amenity: 'fuel', name: 'Fuel' } },
  ] });
  const projected = projectAll(features, {
    lat: 38.5,
    lon: -84.5,
    bbox,
    radiusM: 1000,
    bearing: 0,
    canvasSquares: 1000,
  });

  assert.equal(projected.roads[0].tags.sidewalk, 'both');
  assert.equal(projected.roads[0].crossSection.hierarchy, 'residential');
  assert.equal(projected.roads[0].crossSection.sides.left.sidewalk.presence, 'explicit');
  assert.equal(projected.roads[0].width, projected.roads[0].crossSection.width);
  assert.equal(projected.roads.length, 2);
  assert.equal(projected.roads[1].cls, 'secondary');
  assert.equal(projected.roads[1].tags['lanes:forward'], '1');
  assert.equal(projected.roads[1].tags['parking:right'], 'lane');
  assert.equal(projected.roads[1].tags.bridge, 'yes');
  assert.equal(projected.objects.length, 1);
  assert.equal(projected.objects[0].kind, 'signals');
  assert.equal(projected.pois.length, 1);
  assert.equal(projected.pois[0].tags.amenity, 'fuel');
});
