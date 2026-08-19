import assert from 'node:assert/strict';
import test from 'node:test';

import { auditOsmSemantics, pipelineAudit, renderOsmSemanticsReport } from '../src/catalogue/osm-semantics.js';

const elements = [
  {
    type: 'way',
    id: 1,
    tags: { highway: 'primary', lanes: '4', surface: 'asphalt', bridge: 'yes', name: 'Main' },
    geometry: [{ lon: 1, lat: 2 }, { lon: 2, lat: 3 }],
  },
  {
    type: 'way',
    id: 2,
    tags: { building: 'hospital', amenity: 'hospital', 'building:levels': '3' },
    geometry: [{ lon: 1, lat: 2 }, { lon: 2, lat: 2 }, { lon: 2, lat: 3 }],
  },
  {
    type: 'relation',
    id: 3,
    tags: { building: 'yes', type: 'multipolygon' },
    geometry: [{ lon: 1, lat: 2 }, { lon: 2, lat: 2 }, { lon: 2, lat: 3 }],
  },
  {
    type: 'node',
    id: 4,
    tags: { highway: 'crossing', crossing: 'marked', barrier: 'bollard' },
    lat: 2,
    lon: 1,
  },
];

function inventory() {
  return auditOsmSemantics([{ file: 'fixture.json', data: { elements } }], { generatedAt: 'test' });
}

test('OSM audit distinguishes normalized semantics from discarded tags', () => {
  const out = inventory();
  assert.deepEqual(out.summary.elementTypes, { way: 2, relation: 1, node: 1 });
  assert.equal(out.parser.retainedElements, 4);
  assert.equal(out.parser.discardedElements, 0);
  assert.equal(out.parser.retainedByDestination.roads, 1);
  assert.equal(out.parser.retainedByDestination.buildings, 2);
  assert.equal(out.parser.retainedByDestination.objects, 1);

  const tags = new Map(out.tags.map((tag) => [tag.key, tag]));
  assert.equal(tags.get('highway').retention, 'consumed');
  assert.equal(tags.get('surface').retention, 'consumed');
  assert.equal(tags.get('bridge').retention, 'consumed');
  assert.equal(tags.get('barrier').retention, 'consumed');
  assert.deepEqual(tags.get('building:levels').consumers, ['buildingMetadata']);
});

test('OSM domain audit covers the expanded required semantics', () => {
  const out = inventory();
  assert.equal(out.domains.lanes.tags.find((tag) => tag.key === 'lanes').retention, 'consumed');
  assert.equal(out.domains.surfaces.tags.find((tag) => tag.key === 'surface').retention, 'consumed');
  assert.equal(out.domains.sidewalks.tags.find((tag) => tag.key === 'sidewalk').retention, 'consumed-when-present');
  assert.equal(out.domains.crossings.tags.find((tag) => tag.key === 'crossing').retention, 'consumed');
  assert.equal(out.domains.barriers.tags.find((tag) => tag.key === 'barrier').retention, 'consumed');
});

test('OSM report includes every observed key and all pipeline stages', () => {
  const out = inventory();
  const report = renderOsmSemanticsReport(out);
  for (const key of ['highway', 'surface', 'bridge', 'building:levels', 'crossing', 'barrier']) {
    assert.ok(report.includes(`\`${key}\``), `report should include ${key}`);
  }
  assert.match(report, /Discarded before parsing/);
  assert.match(report, /Clipping and bounds/);
  assert.match(report, /Plan data retention/);
  assert.ok(pipelineAudit().queryDiscarded.some((line) => line.includes('standalone nodes')));
});
