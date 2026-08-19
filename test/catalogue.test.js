import assert from 'node:assert/strict';
import test from 'node:test';

import { TileCatalogue, parseTileDefs } from '../src/formats/tiledefs.js';
import {
  buildVanillaTileCatalogue,
  classifyTileFamily,
  layerSuitability,
  splitTileName,
} from '../src/catalogue/vanilla-tiles.js';

test('tile names split at the final numeric suffix', () => {
  assert.deepEqual(splitTileName('street_curbs_01_diag_2_73'), { tileset: 'street_curbs_01_diag_2', index: 73 });
  assert.deepEqual(splitTileName('fixtures_windows_white_26'), { tileset: 'fixtures_windows_white', index: 26 });
  assert.deepEqual(splitTileName('not-indexed'), { tileset: null, index: null });
});

test('required visual families are distinguished', () => {
  assert.equal(classifyTileFamily('walls_exterior_house_01_0'), 'structural');
  assert.equal(classifyTileFamily('floors_interior_carpet_01_0'), 'floor');
  assert.equal(classifyTileFamily('overlay_grime_floor_01_0'), 'overlay');
  assert.equal(classifyTileFamily('vegetation_trees_01_0'), 'vegetation');
  assert.equal(classifyTileFamily('signs_one-off_01_0'), 'signage');
  assert.equal(classifyTileFamily('blends_street_01_0'), 'road');
  assert.equal(classifyTileFamily('street_curbs_01_0'), 'curb');
  assert.equal(classifyTileFamily('street_trafficlines_01_0'), 'marking');
  assert.equal(classifyTileFamily('furniture_tables_low_01_0'), 'decorative');
  assert.deepEqual(layerSuitability('street_trafficlines_01_0', {}, 'marking'), ['floor-overlay']);
});

test('catalogue includes unannotated sheet slots and observed-only names', () => {
  const definitions = `
    tileset
    {
      file = sample_sheet
      size = 2,2
      // sample_sheet_3
      tile
      {
        xy = 1,1
        FloorMaterial = Wood
      }
    }
  `;
  const cat = new TileCatalogue();
  parseTileDefs(definitions, cat);
  const observations = new Map([
    ['sample_sheet_0', { maps: new Set(['Map A']), cells: new Set(['Map A/0_0']) }],
    ['jumbo_tree_01_0', { maps: new Set(['Map A']), cells: new Set(['Map A/0_0', 'Map A/0_1']) }],
  ]);
  const out = buildVanillaTileCatalogue(cat, observations, { gameVersion: 'test' });

  assert.equal(out.summary.tiles, 5);
  assert.equal(out.summary.sources.declaredSheetSlots, 4);
  assert.equal(out.summary.sources.observedOnly, 1);
  assert.equal(out.tiles.find((tile) => tile.name === 'sample_sheet_0').sources.properties, false);
  assert.deepEqual(out.tiles.find((tile) => tile.name === 'sample_sheet_3').sheet, { width: 2, height: 2, size: 4 });
  const observedOnly = out.tiles.find((tile) => tile.name === 'jumbo_tree_01_0');
  assert.equal(observedOnly.sources.absentFromTileDefinitions, true);
  assert.equal(observedOnly.lotheaderUsage.cellCount, 2);
});
