import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRoad,
  deriveRoadCrossSection,
  loadRoadProfile,
} from '../src/plan/roads.js';

const profile = loadRoadProfile();

const sparseCases = [
  ['motorway', 'highway', 4, 16, 'asphalt'],
  ['trunk', 'highway', 4, 16, 'asphalt'],
  ['primary', 'arterial', 2, 7, 'asphalt'],
  ['tertiary', 'collector', 2, 7, 'asphalt'],
  ['residential', 'residential', 2, 6, 'asphalt'],
  ['service', 'service', 1, 4, 'asphalt'],
  ['unclassified', 'rural', 2, 6, 'asphalt'],
  ['track', 'track', 1, 3, 'unpaved'],
  ['footway', 'path', 1, 2, 'paved'],
];

test('every required hierarchy has a complete sparse-data fallback', () => {
  for (const [highway, hierarchy, lanes, width, surface] of sparseCases) {
    const section = deriveRoadCrossSection({ highway }, profile);
    assert.equal(section.hierarchy, hierarchy, highway);
    assert.equal(section.lanes, lanes, highway);
    assert.equal(section.laneSource, 'hierarchy-fallback', highway);
    assert.equal(section.width, width, highway);
    assert.equal(section.surface, surface, highway);
    assert.ok(section.coreWidth > 0, `${highway} needs a core width`);
    assert.ok(section.carriagewayWidth >= section.coreWidth, `${highway} has an invalid carriageway`);
    for (const side of ['left', 'right']) {
      for (const band of ['shoulder', 'cycleway', 'parking', 'sidewalk']) {
        assert.ok(section.sides[side][band], `${highway} lacks ${side} ${band}`);
      }
    }
  }

  const alley = deriveRoadCrossSection({ highway: 'service', tags: { service: 'alley' } }, profile);
  assert.equal(alley.hierarchy, 'alley');
  assert.equal(alley.width, 3);
});

test('link and one-way fallbacks do not invent divided multi-lane roads', () => {
  const link = deriveRoadCrossSection({ highway: 'motorway_link' }, profile);
  assert.equal(link.lanes, 1);
  assert.equal(link.laneSource, 'highway-link-fallback');
  assert.equal(link.median.presence, 'none');
  assert.equal(link.width, 4);

  const oneWay = deriveRoadCrossSection({ highway: 'primary', tags: { oneway: 'yes' } }, profile);
  assert.equal(oneWay.lanes, 1);
  assert.equal(oneWay.laneSource, 'oneway-fallback');
  assert.equal(oneWay.median.presence, 'none');
});

test('OSM lane, width, surface, median and directional side tags override fallbacks', () => {
  const section = deriveRoadCrossSection({
    highway: 'primary',
    tags: {
      lanes: '4',
      width: '14 m',
      surface: 'concrete',
      median: 'yes',
      'median:width': '1',
      shoulder: 'no',
      'shoulder:left': 'yes',
      'shoulder:left:width': '1.2',
      'shoulder:left:surface': 'gravel',
      'cycleway:right': 'lane',
      'cycleway:right:width': '2',
      'cycleway:right:surface': 'asphalt',
      'parking:left': 'lane',
      'parking:left:orientation': 'diagonal',
      'sidewalk:both': 'yes',
      'sidewalk:left': 'no',
      'sidewalk:right:width': '2',
      'sidewalk:right:surface': 'concrete',
    },
  }, profile);

  assert.equal(section.hierarchy, 'arterial');
  assert.equal(section.lanes, 4);
  assert.equal(section.laneSource, 'lanes');
  assert.equal(section.coreWidth, 14);
  assert.equal(section.laneWidth, 3.5);
  assert.equal(section.surface, 'concrete');
  assert.equal(section.surfaceSource, 'surface');
  assert.equal(section.median.width, 1);
  assert.equal(section.median.source, 'tagged-width');
  assert.equal(section.sides.left.shoulder.width, 1.2);
  assert.equal(section.sides.left.shoulder.surface, 'gravel');
  assert.equal(section.sides.right.shoulder.presence, 'none');
  assert.equal(section.sides.right.cycleway.width, 2);
  assert.equal(section.sides.left.cycleway.presence, 'none');
  assert.equal(section.sides.left.parking.width, 2.5);
  assert.equal(section.sides.left.parking.orientation, 'diagonal');
  assert.equal(section.sides.left.sidewalk.presence, 'none');
  assert.equal(section.sides.right.sidewalk.width, 2);
  assert.equal(section.carriagewayWidth, 19.5);
  assert.equal(section.width, 20);
  assert.equal(section.explicitOuterWidth, 22.7);
});

test('directional lane counts and imperial widths are normalized deterministically', () => {
  const directional = deriveRoadCrossSection({
    highway: 'secondary',
    tags: { 'lanes:forward': '2', 'lanes:backward': '1', 'lanes:both_ways': '1' },
  }, profile);
  assert.equal(directional.lanes, 4);
  assert.equal(directional.laneSource, 'directional-lanes');
  assert.equal(directional.coreWidth, 14);

  const imperial = deriveRoadCrossSection({
    highway: 'residential',
    tags: { lanes: '2', width: '32 ft' },
  }, profile);
  assert.ok(Math.abs(imperial.coreWidth - 9.7536) < 1e-9);
  assert.ok(Math.abs(imperial.laneWidth - 4.8768) < 1e-9);
});

test('sidewalk fallback is explicit about built-up context instead of always painting one', () => {
  const urban = classifyRoad({ highway: 'residential' }, profile);
  assert.equal(urban.sides.left.sidewalk.presence, 'implicit');
  assert.equal(urban.sides.right.sidewalk.presence, 'implicit');
  assert.equal(urban.explicitOuterWidth, urban.carriagewayWidth);
  // One square of pavement each side, not two: beside a vanilla kerb the
  // pavement is one square wide 63% of the time and two only 13%.
  assert.equal(urban.builtUpWidth, urban.carriagewayWidth + 2);

  const rural = classifyRoad({ highway: 'unclassified' }, profile);
  assert.equal(rural.sides.left.sidewalk.presence, 'none');
  assert.equal(rural.sides.right.sidewalk.presence, 'none');
  assert.equal(rural.sides.left.shoulder.presence, 'fallback');
  assert.equal(rural.sides.right.shoulder.presence, 'fallback');
});

test('unknown and ignored highway values remain excluded', () => {
  assert.equal(deriveRoadCrossSection({ highway: 'construction' }, profile), null);
  assert.equal(deriveRoadCrossSection({ highway: 'not_a_road' }, profile), null);
  assert.equal(deriveRoadCrossSection({}, profile), null);
});
