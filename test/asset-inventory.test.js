import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAssetInventory,
  classifyAssetCoverage,
  inferAssetRole,
  renderAssetCoverageReport,
} from '../src/catalogue/asset-inventory.js';

function tile(overrides = {}) {
  return {
    name: 'sample_sheet_0',
    tileset: 'sample_sheet',
    index: 0,
    family: 'decorative',
    properties: {},
    declaredRoles: [],
    layerSuitability: ['object'],
    sources: {
      declaredSheet: true,
      properties: false,
      lotheader: false,
      absentFromTileDefinitions: false,
      outsideDeclaredSheet: false,
    },
    lotheaderUsage: { mapCount: 0, cellCount: 0 },
    ...overrides,
  };
}

test('coverage distinguishes all required support statuses', () => {
  assert.equal(classifyAssetCoverage(tile(), new Set(), new Set()).supportStatus, 'unknown');
  assert.equal(classifyAssetCoverage(tile({ family: 'curb' }), new Set(), new Set()).supportStatus, 'mapped-but-unused');
  assert.equal(classifyAssetCoverage(tile(), new Set(['sample_sheet_0']), new Set()).supportStatus, 'used');
  assert.equal(classifyAssetCoverage(tile({ tileset: null, index: null }), new Set(), new Set()).supportStatus, 'incompatible');
  assert.equal(classifyAssetCoverage(tile({
    family: 'structural',
    properties: { WallN: true },
    sources: { declaredSheet: true, properties: true, lotheader: true, outsideDeclaredSheet: false },
  }), new Set(), new Set()).supportStatus, 'intentionally-excluded');
});

test('property-driven blend assets are used and roles reflect attachments', () => {
  const blend = tile({
    name: 'blends_natural_01_17',
    tileset: 'blends_natural_01',
    index: 17,
    family: 'floor',
    properties: { FloorMaterial: 'Grass_Dark', IsFloorAttached: true, FloorAttachmentN: true },
  });
  assert.equal(inferAssetRole(blend), 'surface-edge');
  assert.equal(classifyAssetCoverage(blend, new Set(), new Set(['Grass_Dark'])).supportStatus, 'used');
});

test('inventory groups assets and uses contextual orientation evidence', () => {
  const catalogue = {
    gameVersion: 'test',
    tiles: [tile({
      name: 'street_curbs_01_8',
      tileset: 'street_curbs_01',
      index: 8,
      family: 'curb',
      sources: { declaredSheet: true, properties: true, lotheader: true, outsideDeclaredSheet: false },
      lotheaderUsage: { mapCount: 1, cellCount: 2 },
    })],
  };
  const context = { tiles: [{
    name: 'street_curbs_01_8',
    frequency: { placements: 12, cellCount: 2 },
    orientationEvidence: { inferred: 'east-west', confidence: 0.75 },
    roadContext: [{ value: 'road-edge', count: 12 }],
    runPosition: [{ value: 'middle-ew', count: 10 }],
  }] };
  const inventory = buildAssetInventory(catalogue, context, { generatedAt: 'fixed' });
  assert.equal(inventory.assets[0].orientation, 'east-west');
  assert.equal(inventory.assets[0].variant.group, 'block-0');
  assert.equal(inventory.families[0].contextualPlacements, 12);
  assert.equal(inventory.summary.supportStatuses['mapped-but-unused'], 1);
  const report = renderAssetCoverageReport(inventory);
  assert.match(report, /Coverage by asset family/);
  assert.match(report, /street_curbs_01/);
});
