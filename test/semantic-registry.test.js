import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  assertValidSemanticRegistry,
  compatibleSemanticRegistry,
  createAssetCompatibility,
  loadSemanticRegistry,
  resolveCompatibleSemantic,
  resolveSemantic,
  selectSemanticVariant,
  validateSemanticRegistry,
} from '../src/catalogue/semantic-registry.js';

const registry = loadSemanticRegistry();

test('registry resolves normalized classes plus directional and topological context', () => {
  assert.equal(
    resolveSemantic(registry, 'road.surface', { roadClass: 'track' }).id,
    'road.surface.track',
  );
  assert.equal(
    resolveSemantic(registry, 'road.curb', {
      roadClass: 'residential',
      orientation: 'east',
      topology: 'edge',
    }).variants[0].tile,
    'street_curbs_01_9',
  );
  assert.equal(
    resolveSemantic(registry, 'road.curb', {
      roadClass: 'residential',
      orientation: 'nw-se',
      topology: 'diagonal',
    }).layer,
    'FloorOverlay',
  );
});

test('explicit exclusions win and unsafe topology does not fall back to straight artwork', () => {
  const noMarking = resolveSemantic(registry, 'road.marking.centre', {
    markings: 'no',
    orientation: 'north-south',
    topology: 'straight',
  });
  assert.equal(noMarking.id, 'road.marking.none');
  assert.deepEqual(noMarking.variants, []);
  assert.ok(noMarking.exclusions.length);

  const junction = resolveSemantic(registry, 'road.curb', {
    roadClass: 'residential',
    orientation: 'east',
    topology: 'tee',
  });
  assert.equal(junction.id, 'road.curb.unsupported-topology');
  assert.equal(selectSemanticVariant(junction, '10,20'), null);

  const unedged = resolveSemantic(registry, 'road.curb', {
    roadClass: 'track',
    orientation: 'east',
    topology: 'edge',
  });
  assert.equal(unedged.id, 'road.curb.unedged-class');
});

test('fallbacks terminate at a validated asset mapping', () => {
  const cycleway = resolveSemantic(registry, 'road.surface', { roadClass: 'cycleway' });
  assert.equal(cycleway.id, 'road.surface.asphalt-fallback');
  assert.equal(cycleway.variants[0].tile, 'blends_street_01_86');
});

test('weighted selection is deterministic and honors placement chance', () => {
  const plants = resolveSemantic(registry, 'procedural.vegetation', { biome: 'wild' });
  assert.equal(selectSemanticVariant(plants, 'seed:42,17'), selectSemanticVariant(plants, 'seed:42,17'));
  assert.equal(selectSemanticVariant({ ...plants, chance: 0 }, 'seed:42,17'), null);
});

test('every committed registry asset is compatible with the Build 42 inventory', () => {
  const inventory = JSON.parse(fs.readFileSync('library/asset-inventory.json', 'utf8'));
  const result = validateSemanticRegistry(registry, inventory);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.referencedAssets >= 50);
});

test('validation rejects unknown assets and context-required misuse', () => {
  const inventory = {
    assets: [{
      name: 'edge_0',
      assetFamily: 'edge',
      role: 'road-edge',
      layerSuitability: ['road-edge'],
      safetyStatus: 'context-required',
      supportStatus: 'used',
    }],
  };
  const fake = {
    mappings: [{
      id: 'bad', semantic: 'road.curb', when: {}, chance: 1, layer: 'FloorFurniture',
      role: 'road-edge', exclusions: [], variants: [{ tile: 'edge_0', weight: 1 }, { tile: 'missing_0', weight: 1 }],
    }],
  };
  const result = validateSemanticRegistry(fake, inventory);
  assert.ok(result.errors.some((error) => error.includes('context-required')));
  assert.ok(result.errors.some((error) => error.includes('unknown tile missing_0')));
});

function fakeAsset(name, overrides = {}) {
  return {
    name,
    assetFamily: 'test',
    role: 'road-edge',
    layerSuitability: ['road-edge'],
    safetyStatus: 'safe',
    supportStatus: 'used',
    sources: { declaredSheet: true, lotheader: false },
    ...overrides,
  };
}

function fakeMapping(id, variants, overrides = {}) {
  return {
    id,
    semantic: 'test.semantic',
    when: {},
    chance: 1,
    layer: 'FloorFurniture',
    role: 'road-edge',
    exclusions: [],
    mandatory: false,
    variants,
    ...overrides,
  };
}

function fakeRegistry(mappings) {
  return { mappings, byId: new Map(mappings.map((mapping) => [mapping.id, mapping])) };
}

test('installed sheet bounds and observed lotheaders determine asset availability', () => {
  const inventory = { assets: [
    fakeAsset('sheet_1'),
    fakeAsset('observed_99', { sources: { declaredSheet: false, lotheader: true } }),
    fakeAsset('missing_2'),
  ] };
  const installed = { tileExists: (tile) => tile === 'sheet_1' };
  const compatibility = createAssetCompatibility(inventory, installed);

  assert.equal(compatibility.has('sheet_1'), true);
  assert.equal(compatibility.has('observed_99'), true);
  assert.equal(compatibility.has('missing_2'), false);
  assert.deepEqual(compatibility.evidence('observed_99'), {
    asset: inventory.assets[1], installedSheet: false, lotheader: true,
    declaredSheet: false, allowed: true, available: true,
  });
});

test('unavailable variants follow fallback chains deterministically', () => {
  const primary = fakeMapping('primary', [
    { tile: 'missing_0', weight: 100 },
  ], { fallback: 'fallback', priority: 1 });
  const fallback = fakeMapping('fallback', [
    { tile: 'available_0', weight: 1 },
  ], { when: { fallback: true } });
  const registry = fakeRegistry([primary, fallback]);
  const inventory = { assets: [fakeAsset('missing_0'), fakeAsset('available_0')] };
  const compatibility = createAssetCompatibility(inventory, {
    tileExists: (tile) => tile === 'available_0',
  });

  const resolved = resolveCompatibleSemantic(registry, 'test.semantic', {}, compatibility);
  assert.equal(resolved.id, 'fallback');
  assert.equal(selectSemanticVariant(resolved, 'same-placement'), 'available_0');

  const filtered = compatibleSemanticRegistry(registry, compatibility);
  assert.equal(resolveSemantic(filtered, 'test.semantic', {}).id, 'fallback');
  assert.equal(resolveSemantic(filtered, 'test.semantic', {}).variants[0].tile, 'available_0');
});

test('validation enforces layer and directional variant requirements', () => {
  const mapping = fakeMapping('directional', [{ tile: 'edge_0', weight: 1 }], {
    when: { orientation: 'east' },
  });
  const result = validateSemanticRegistry(fakeRegistry([mapping]), {
    assets: [fakeAsset('edge_0', { layerSuitability: ['floor'] })],
  });

  assert.ok(result.errors.some((error) => error.includes('unsuitable for FloorFurniture')));
  assert.ok(result.errors.some((error) => error.includes('requires variant.orientation')));
});

test('invalid mandatory mappings fail clearly after exhausting fallbacks', () => {
  const primary = fakeMapping('mandatory-primary', [{ tile: 'missing_0', weight: 1 }], {
    mandatory: true,
    fallback: 'mandatory-fallback',
  });
  const fallback = fakeMapping('mandatory-fallback', [{ tile: 'missing_1', weight: 1 }], {
    when: { fallback: true },
  });
  const registry = fakeRegistry([primary, fallback]);
  const inventory = { assets: [fakeAsset('missing_0'), fakeAsset('missing_1')] };
  const compatibility = createAssetCompatibility(inventory, { tileExists: () => false });

  assert.throws(
    () => assertValidSemanticRegistry(registry, inventory, { compatibility }),
    /mandatory-primary: mandatory mapping has no available variants \(fallback chain: mandatory-primary -> mandatory-fallback\)/,
  );
});
