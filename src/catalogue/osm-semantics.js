import { buildQuery, normalise } from '../sources/osm.js';

/**
 * Reproducible audit of the OpenStreetMap ingestion boundary.
 *
 * This module intentionally describes both kinds of retention in the pipeline:
 * structural retention (a tag is still present on a normalised feature) and
 * semantic consumption (a later classifier actually reads it). Keeping those
 * separate prevents "we kept tags" from being mistaken for "we use tags".
 */

const LAND_VALUES = ['forest', 'farmland', 'farmyard', 'meadow', 'grass', 'orchard', 'vineyard', 'cemetery', 'residential', 'commercial', 'industrial', 'retail', 'recreation_ground', 'village_green', 'brownfield', 'construction', 'quarry', 'reservoir', 'basin'];
const NATURAL_VALUES = ['wood', 'scrub', 'grassland', 'heath', 'wetland', 'water', 'beach', 'sand', 'bare_rock', 'shingle'];
const LANDCOVER_VALUES = ['trees', 'grass', 'scrub', 'bushes', 'flowerbed', 'bare_rock', 'sand', 'gravel'];
const LEISURE_VALUES = ['park', 'pitch', 'garden', 'golf_course', 'playground', 'sports_centre'];
const WATERWAY_VALUES = ['river', 'stream', 'canal', 'drain', 'ditch'];
const ROAD_VALUES = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service', 'track', 'footway', 'path', 'pedestrian', 'cycleway', 'steps'];
const ROAD_NODE_VALUES = ['crossing', 'traffic_signals', 'stop', 'give_way', 'turning_circle', 'mini_roundabout', 'motorway_junction', 'street_lamp'];
const BARRIER_VALUES = ['bollard', 'block', 'chain', 'cycle_barrier', 'entrance', 'fence', 'gate', 'guard_rail', 'hedge', 'jersey_barrier', 'kerb', 'kissing_gate', 'lift_gate', 'retaining_wall', 'sally_port', 'swing_gate', 'wall'];
const AMENITY_VALUES = ['parking', 'fuel', 'hospital', 'clinic', 'doctors', 'pharmacy', 'police', 'fire_station', 'school', 'college', 'kindergarten', 'university', 'library', 'restaurant', 'cafe', 'fast_food', 'pub', 'bar', 'nightclub', 'bank', 'post_office', 'townhall', 'courthouse', 'prison', 'place_of_worship', 'community_centre', 'toilets'];
const SHOP_VALUES = ['supermarket', 'convenience', 'grocery', 'greengrocer', 'bakery', 'butcher', 'clothes', 'department_store', 'doityourself', 'hardware', 'car_repair', 'car', 'mall', 'chemist', 'medical_supply', 'general', 'variety_store'];
const OFFICE_VALUES = ['government', 'company', 'association', 'educational_institution', 'lawyer', 'financial', 'insurance', 'estate_agent', 'ngo', 'healthcare'];
const TOURISM_VALUES = ['hotel', 'motel', 'camp_site', 'museum', 'attraction'];

export const QUERY_SELECTORS = [
  ...['way', 'relation'].flatMap((element) => [
    { element, tag: 'building', match: 'present', destination: 'buildings' },
    { element, tag: 'building:part', match: 'present', destination: 'buildings' },
  ]),
  { element: 'way', tag: 'highway', match: 'one-of', values: ROAD_VALUES, destination: 'roads' },
  { element: 'node', tag: 'highway', match: 'one-of', values: ROAD_NODE_VALUES, destination: 'objects' },
  ...['node', 'way'].flatMap((element) => [
    { element, tag: 'traffic_sign', match: 'present', destination: 'objects' },
    { element, tag: 'barrier', match: 'one-of', values: BARRIER_VALUES, destination: 'objects' },
  ]),
  ...['way', 'relation'].flatMap((element) => [
    { element, tag: 'landuse', match: 'one-of', values: LAND_VALUES, destination: 'ground' },
    { element, tag: 'natural', match: 'one-of', values: NATURAL_VALUES, destination: 'ground' },
    { element, tag: 'landcover', match: 'one-of', values: LANDCOVER_VALUES, destination: 'ground' },
    { element, tag: 'leisure', match: 'one-of', values: LEISURE_VALUES, destination: 'ground' },
    { element, tag: 'waterway', match: 'one-of', values: WATERWAY_VALUES, destination: 'ground' },
  ]),
  ...['node', 'way', 'relation'].map((element) => ({ element, tag: 'amenity', match: 'one-of', values: AMENITY_VALUES, destination: 'poi-or-ground' })),
  ...['node', 'way', 'relation'].flatMap((element) => [
    { element, tag: 'shop', match: 'one-of', values: SHOP_VALUES, destination: 'pois' },
    { element, tag: 'office', match: 'one-of', values: OFFICE_VALUES, destination: 'pois' },
    { element, tag: 'tourism', match: 'one-of', values: TOURISM_VALUES, destination: 'pois' },
  ]),
];

export const SEMANTIC_TAGS = {
  buildingClassification: ['amenity', 'shop', 'office', 'building'],
  buildingMetadata: ['building:levels', 'height', 'name'],
  roadClassification: ['highway', 'lanes'],
  roadMetadata: ['oneway', 'name'],
  normalizedRoadSemantics: [
    'service', 'junction', 'lanes:forward', 'lanes:backward', 'lanes:both_ways',
    'turn:lanes', 'turn:lanes:forward', 'turn:lanes:backward',
    'width', 'placement', 'placement:forward', 'placement:backward',
    'surface', 'smoothness', 'tracktype', 'surface:condition', 'condition',
    'lane_markings', 'lane_markings:forward', 'lane_markings:backward',
    'centre_marking', 'marking:centre', 'markings', 'divider',
    'change:lanes', 'change:lanes:forward', 'change:lanes:backward',
    'shoulder', 'shoulder:left', 'shoulder:right', 'shoulder:both',
    'shoulder:surface', 'shoulder:left:surface', 'shoulder:right:surface',
    'shoulder:width', 'shoulder:left:width', 'shoulder:right:width', 'shoulder:both:width',
    'cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both',
    'cycleway:surface', 'cycleway:left:surface', 'cycleway:right:surface', 'cycleway:both:surface',
    'cycleway:width', 'cycleway:left:width', 'cycleway:right:width', 'cycleway:both:width',
    'median', 'median:width', 'divider:width',
    'sidewalk', 'sidewalk:left', 'sidewalk:right', 'sidewalk:both',
    'sidewalk:surface', 'sidewalk:left:surface', 'sidewalk:right:surface', 'sidewalk:both:surface',
    'sidewalk:width', 'sidewalk:left:width', 'sidewalk:right:width', 'sidewalk:both:width',
    'crossing', 'crossing:markings', 'crossing:signals', 'crossing:island',
    'kerb', 'kerb:left', 'kerb:right', 'tactile_paving',
    'bridge', 'bridge:structure', 'layer', 'covered', 'tunnel',
    'traffic_sign', 'traffic_sign:forward', 'traffic_sign:backward',
    'parking', 'parking:left', 'parking:right', 'parking:both',
    'parking:left:orientation', 'parking:right:orientation', 'parking:both:orientation',
    'parking:lane:both', 'parking:lane:left', 'parking:lane:right',
    'parking:width', 'parking:left:width', 'parking:right:width', 'parking:both:width',
  ],
  normalizedObjects: [
    'barrier', 'traffic_sign', 'traffic_sign:forward', 'traffic_sign:backward',
    'traffic_sign:direction', 'direction', 'information',
    'crossing', 'crossing:markings', 'crossing:signals', 'crossing:island',
    'kerb', 'tactile_paving',
  ],
  groundClassification: ['natural', 'waterway', 'landuse', 'landcover', 'leisure', 'amenity'],
  normalizedPois: ['amenity', 'shop', 'office', 'tourism'],
};

export const REQUESTED_DOMAINS = {
  roads: ['highway', 'service', 'junction', 'oneway', 'width', 'placement', 'placement:forward', 'placement:backward'],
  lanes: ['lanes', 'lanes:forward', 'lanes:backward', 'lanes:both_ways'],
  markings: [
    'turn:lanes', 'turn:lanes:forward', 'turn:lanes:backward',
    'lane_markings', 'lane_markings:forward', 'lane_markings:backward',
    'centre_marking', 'marking:centre', 'markings', 'divider',
    'change:lanes', 'change:lanes:forward', 'change:lanes:backward',
  ],
  surfaces: ['surface', 'shoulder:surface', 'shoulder:left:surface', 'shoulder:right:surface'],
  condition: ['smoothness', 'tracktype', 'surface:condition', 'condition'],
  sidewalks: [
    'sidewalk', 'sidewalk:left', 'sidewalk:right', 'sidewalk:both',
    'sidewalk:surface', 'sidewalk:left:surface', 'sidewalk:right:surface', 'sidewalk:both:surface',
    'sidewalk:width', 'sidewalk:left:width', 'sidewalk:right:width', 'sidewalk:both:width',
  ],
  crossings: [
    'crossing', 'crossing:markings', 'crossing:signals', 'crossing:island',
    'kerb', 'kerb:left', 'kerb:right', 'tactile_paving',
  ],
  bridges: ['bridge', 'bridge:structure', 'layer', 'covered', 'tunnel'],
  buildings: ['building', 'building:part', 'building:levels', 'height'],
  amenities: ['amenity', 'shop', 'office', 'tourism'],
  landUse: ['landuse', 'landcover', 'leisure', 'natural', 'waterway', 'water'],
  vegetation: ['natural', 'landuse', 'landcover', 'leaf_type', 'leaf_cycle', 'species', 'genus'],
  barriers: ['barrier'],
  parking: [
    'amenity', 'parking', 'parking:left', 'parking:right', 'parking:both',
    'parking:left:orientation', 'parking:right:orientation', 'parking:both:orientation',
    'parking:lane:both', 'parking:lane:left', 'parking:lane:right', 'capacity', 'capacity:disabled',
  ],
  signs: [
    'traffic_sign', 'traffic_sign:forward', 'traffic_sign:backward',
    'traffic_sign:direction', 'direction', 'information', 'destination',
  ],
  streetFurniture: ['highway', 'lit'],
};

const consumed = new Map();
for (const [consumer, tags] of Object.entries(SEMANTIC_TAGS)) {
  for (const tag of tags) {
    if (!consumed.has(tag)) consumed.set(tag, []);
    consumed.get(tag).push(consumer);
  }
}

function selectorMatches(el, selector) {
  if (el.type !== selector.element) return false;
  const value = el.tags?.[selector.tag];
  if (value === undefined) return false;
  if (selector.match === 'present' || selector.match === 'selected') return true;
  return selector.values.includes(value);
}

function wouldQueryElement(el) {
  return QUERY_SELECTORS.some((selector) => selectorMatches(el, selector));
}

function normalisedDestinations(el) {
  const parsed = normalise({ elements: [el] });
  return ['buildings', 'roads', 'ground', 'objects', 'pois'].filter((key) => parsed[key].length);
}

function geometryKind(destination, feature) {
  if (feature.geometry === 'point') return 'point';
  if (destination === 'roads') return 'polyline';
  if (feature.geometry === 'line') return 'line';
  return feature.points.length >= 3 ? 'closed-ring' : 'short-line';
}

function increment(object, key, amount = 1) {
  object[key] = (object[key] ?? 0) + amount;
}

function tagRecord(records, key) {
  if (!records.has(key)) {
    records.set(key, {
      key,
      observedElements: 0,
      observedByElementType: {},
      queriedElements: 0,
      parserRetainedElements: 0,
      parserDiscardedElements: 0,
      values: {},
      consumers: consumed.get(key) ?? [],
    });
  }
  return records.get(key);
}

/** Audit raw Overpass responses currently available to the project. */
export function auditOsmSemantics(sources, { generatedAt = new Date().toISOString() } = {}) {
  const elementTypes = {};
  const parser = {
    inputElements: 0,
    retainedElements: 0,
    discardedElements: 0,
    retainedByDestination: { buildings: 0, roads: 0, ground: 0, objects: 0, pois: 0 },
    discardedReasons: { missingGeometry: 0, unmatchedTags: 0 },
    geometry: {},
  };
  const tags = new Map();

  for (const source of sources) {
    for (const el of source.data.elements ?? []) {
      const type = el.type ?? 'unknown';
      increment(elementTypes, type);
      parser.inputElements++;
      const queried = wouldQueryElement(el);
      const parsed = normalise({ elements: [el] });
      const destinations = normalisedDestinations(el);
      if (destinations.length) {
        parser.retainedElements++;
        for (const destination of destinations) {
          parser.retainedByDestination[destination] += parsed[destination].length;
          for (const feature of parsed[destination]) {
            increment(parser.geometry, geometryKind(destination, feature));
          }
        }
      } else {
        parser.discardedElements++;
        const hasGeometry = Array.isArray(el.geometry) ||
          (Number.isFinite(el.lon) && Number.isFinite(el.lat)) ||
          el.members?.some((member) => Array.isArray(member.geometry));
        if (!hasGeometry) parser.discardedReasons.missingGeometry++;
        else parser.discardedReasons.unmatchedTags++;
      }

      for (const [key, value] of Object.entries(el.tags ?? {})) {
        const record = tagRecord(tags, key);
        record.observedElements++;
        increment(record.observedByElementType, type);
        if (queried) record.queriedElements++;
        if (destinations.length && Object.values(parsed).some((features) =>
          Array.isArray(features) && features.some((feature) => key in feature.tags)
        )) record.parserRetainedElements++;
        else record.parserDiscardedElements++;
        increment(record.values, String(value));
      }
    }
  }

  const tagList = [...tags.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const tag of tagList) {
    tag.retention = tag.parserRetainedElements
      ? (tag.consumers.length ? 'consumed' : 'carried-only')
      : 'discarded';
    tag.distinctValues = Object.keys(tag.values).length;
    tag.values = Object.fromEntries(Object.entries(tag.values).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  }

  const statusCounts = {};
  for (const tag of tagList) increment(statusCounts, tag.retention);

  return {
    schemaVersion: 1,
    generatedAt,
    sources: sources.map((source) => ({ file: source.file, elements: source.data.elements?.length ?? 0 })),
    query: {
      selectors: QUERY_SELECTORS,
      elementTypesRequested: {
        node: 'selected road control/furniture, sign, barrier, amenity, shop, office, and tourism nodes',
        way: 'roads/buildings plus selected sign, barrier, land cover, amenity, shop, office, and tourism ways',
        relation: 'buildings/building parts plus selected land cover, amenity, shop, office, and tourism relations',
      },
      outputMode: 'out geom(bbox): inline coordinates clipped to the request; referenced nodes are not emitted',
      payloadBounds: {
        radiusMetres: 12000,
        geometryClippedToBbox: true,
        recursiveNodeExpansion: false,
        tagSchema: 'finite allow-list in src/sources/osm.js',
        query: buildQuery({ south: 0, west: 0, north: 1, east: 1 }),
      },
    },
    summary: {
      sourceFiles: sources.length,
      elements: parser.inputElements,
      elementTypes,
      tags: tagList.length,
      tagStatuses: statusCounts,
    },
    parser,
    tags: tagList,
    domains: buildDomainAudit(tagList),
    pipeline: pipelineAudit(),
  };
}

function buildDomainAudit(tags) {
  const byKey = new Map(tags.map((tag) => [tag.key, tag]));
  return Object.fromEntries(Object.entries(REQUESTED_DOMAINS).map(([domain, keys]) => {
    const records = keys.map((key) => byKey.get(key) ?? {
      key,
      observedElements: 0,
      parserRetainedElements: 0,
      consumers: consumed.get(key) ?? [],
      retention: consumed.has(key) ? 'consumed-when-present' : 'not-requested-or-consumed',
    });
    return [domain, { tags: records }];
  }));
}

export function pipelineAudit() {
  return {
    queryDiscarded: [
      'Unselected standalone nodes (including arbitrary tagged nodes and individual way nodes) and recursive node expansion.',
      'Route and other unrelated relations; land-cover, amenity, shop, office and tourism values outside explicit allow-lists.',
      'Trees, benches and waste baskets are intentionally deferred: querying every one in a dense city would dominate payload size.',
      'Geometry outside the requested bbox is clipped by Overpass output, and requests over the 12 km radius cap are refused.',
    ],
    parserRetained: [
      'A finite allow-list retains required road classes, cross-sections, markings, sidewalks, crossings, junctions, bridges, surfaces, condition, signs, parking, land cover, vegetation metadata and POI classification.',
      'Coordinates become [longitude, latitude]; identity becomes a geometry hash; OSM ids, versions and node ids are discarded.',
      'Point features become objects or POIs; roads remain polylines; areas are closed; multipolygon outer member segments are stitched into rings.',
    ],
    parserDiscarded: [
      'Returned elements without usable inline point, geometry or relation-member geometry.',
      'Tags outside the finite semantic schema, including import provenance and contact metadata.',
      'Multipolygon inner rings are not represented because the current plan polygon schema has no holes.',
    ],
    clipping: [
      'Overpass clips inline geometry to the requested bbox before download, bounding long roads, rivers and relations.',
      'Legacy buildPlan clips road polylines and overlap-filters buildings, ground, objects and POIs.',
      'Authored generateWorld overlap-filters all normalized destinations; raster/surface writers clamp effects to world bounds.',
    ],
    classification: [
      'Buildings consume amenity/shop/office/building; building:levels and height derive levels.',
      'Roads consume highway and lanes today; all additional cross-section and artwork semantics remain available on road tags for subsequent renderer tasks.',
      'Ground consumes natural/waterway/landuse/leisure/parking. Relevant non-parking amenities, shops, offices and tourism features normalize as POIs.',
      'Crossings, signals, stop/give-way signs, junction points, barriers and selected street furniture normalize as typed objects.',
    ],
    planData: [
      'Authored generated results expose projected roads, cover, objects and POIs with bounded semantic tags.',
      'Legacy buildPlan exposes the same projected records under sourceFeatures while preserving its existing raster roads and ground outputs.',
      'Building placements still retain placement/class metadata rather than source tags; source building semantics are consumed during placement.',
    ],
  };
}

export function renderOsmSemanticsReport(inventory) {
  const count = (n) => Number(n ?? 0).toLocaleString('en-US');
  const lines = [
    '# OpenStreetMap Retention and Geometry Audit',
    '',
    '> Generated by `npm run inventory-osm`. Do not edit observed counts by hand.',
    '',
    `This audit covers ${count(inventory.summary.elements)} cached Overpass elements across ${inventory.summary.sourceFiles} responses and ${count(inventory.summary.tags)} observed tag keys.`,
    '',
    '## Executive summary',
    '',
    `- Element types observed: ${Object.entries(inventory.summary.elementTypes).map(([k, v]) => `\`${k}\` ${count(v)}`).join(', ') || 'none'}.`,
    `- Normaliser: ${count(inventory.parser.retainedElements)} retained; ${count(inventory.parser.discardedElements)} discarded.`,
    `- Tag keys: ${Object.entries(inventory.summary.tagStatuses).map(([k, v]) => `${count(v)} ${k}`).join(', ')}.`,
    '- **Carried-only** means the complete tag survives normalisation but no current classifier or planner reads it.',
    '',
    '## Query and element geometry',
    '',
    '| OSM element | Current treatment |',
    '|---|---|',
    ...Object.entries(inventory.query.elementTypesRequested).map(([type, treatment]) => `| \`${type}\` | ${treatment} |`),
    '',
    `Overpass output is \`${inventory.query.outputMode}\`.`,
    '',
    '| Normalised destination | Elements | Geometry |',
    '|---|---:|---|',
    `| buildings | ${count(inventory.parser.retainedByDestination.buildings)} | closed ring when >=3 points |`,
    `| roads | ${count(inventory.parser.retainedByDestination.roads)} | polyline |`,
    `| ground | ${count(inventory.parser.retainedByDestination.ground)} | closed ring when >=3 points |`,
    `| objects | ${count(inventory.parser.retainedByDestination.objects)} | point or line |`,
    `| POIs | ${count(inventory.parser.retainedByDestination.pois)} | point, line or area |`,
    '',
    '### Payload bounds',
    '',
    `- Maximum request radius: ${count(inventory.query.payloadBounds.radiusMetres)} m.`,
    '- Geometry is clipped to the requested bbox in Overpass output.',
    '- No recursive way-node expansion is used.',
    '- Query values and normalized tags use finite allow-lists.',
    '',
    '## Requested semantic domains',
    '',
    '| Domain | Consumed now | Carried but ignored / unavailable |',
    '|---|---|---|',
  ];

  for (const [domain, audit] of Object.entries(inventory.domains)) {
    const used = audit.tags.filter((tag) => tag.consumers.length).map((tag) => `\`${tag.key}\``);
    const ignored = audit.tags.filter((tag) => !tag.consumers.length).map((tag) => `\`${tag.key}\`${tag.observedElements ? ` (${count(tag.observedElements)})` : ''}`);
    lines.push(`| ${domain} | ${used.join(', ') || 'none'} | ${ignored.join(', ') || 'none'} |`);
  }

  const headings = {
    queryDiscarded: 'Discarded before parsing (query boundary)',
    parserRetained: 'Retained by normalisation',
    parserDiscarded: 'Discarded or distorted by normalisation',
    clipping: 'Clipping and bounds',
    classification: 'Classification',
    planData: 'Plan data retention',
  };
  for (const [key, title] of Object.entries(headings)) {
    lines.push('', `## ${title}`, '');
    for (const item of inventory.pipeline[key]) lines.push(`- ${item}`);
  }

  lines.push('', '## Every observed tag key', '', '| Tag | Elements | Status | Current consumers | Distinct values |', '|---|---:|---|---|---:|');
  for (const tag of inventory.tags) {
    lines.push(`| \`${tag.key.replaceAll('|', '\\|')}\` | ${count(tag.observedElements)} | ${tag.retention} | ${tag.consumers.join(', ') || 'none'} | ${count(tag.distinctValues)} |`);
  }
  lines.push('', 'Full value frequencies and per-element-type counts are in `library/osm-semantics.json`.', '');
  return lines.join('\n');
}
