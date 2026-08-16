/**
 * The built-in prototype set.
 *
 * These buildings are the only ones this project authors itself, so nothing
 * else validates them. The trap they exist to guard against is a real one that
 * was hit while writing them: wall sheets do **not** share a tile layout.
 * `walls_exterior_house_01` puts the west wall at index 0 and the corner at 2,
 * while `walls_commercial_01` has windows at 0 and 1, and `walls_garage_01`'s
 * corner is at 34. Hard-coding the house layout across every kit builds walls
 * out of windows — silently, because a wrong tile still renders.
 *
 * So kits are derived from the tile catalogue by declared role, and these tests
 * check that what comes out really is a sealed building.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStarterLibrary,
  starterTileNames,
  makeBuilding,
  kitFromTileset,
  KITS,
} from '../src/prefab/starter.js';
import { loadTileCatalogue } from '../src/formats/tiledefs.js';
import { rotate } from '../src/prefab/schematic.js';
import { findInstall, readMapTileNames } from '../src/lib/pzinstall.js';
import { Library } from '../src/plan/buildings.js';

let INSTALL = null;
try {
  INSTALL = findInstall();
} catch {
  /* skipped below */
}
const skip = INSTALL ? false : 'Project Zomboid install not found';

let CAT = null;
function catalogue() {
  if (!CAT) CAT = loadTileCatalogue(INSTALL);
  return CAT;
}

test('every sheet used by a kit carries a complete wall set', { skip }, () => {
  const cat = catalogue();
  for (const [name, tileset] of Object.entries(KITS)) {
    const kit = kitFromTileset(cat, tileset);
    assert.ok(kit, `${name} (${tileset}) has no usable kit`);
    for (const part of ['wallN', 'wallW', 'corner', 'doorN', 'doorW']) {
      assert.ok(kit[part], `${tileset} has no ${part}`);
    }
    // The parts must genuinely be what they claim.
    assert.equal(cat.role(kit.wallN).dir, 'N', `${tileset} wallN faces the wrong way`);
    assert.equal(cat.role(kit.wallW).dir, 'W', `${tileset} wallW faces the wrong way`);
    assert.equal(cat.role(kit.wallN).kind, 'wall', `${tileset} wallN is not a wall`);
    assert.equal(cat.role(kit.doorN).kind, 'door', `${tileset} doorN is not a door`);
    // And the corner must join those two walls, not some other pair.
    const parts = cat.splitCorner(kit.corner);
    if (parts) {
      assert.equal(parts.north, kit.wallN, `${tileset} corner joins a different north wall`);
      assert.equal(parts.west, kit.wallW, `${tileset} corner joins a different west wall`);
    }
  }
});

test('every tile name the built-in set can emit exists in the game', { skip }, () => {
  const cat = catalogue();
  const fromMaps = readMapTileNames(INSTALL);
  const missing = [...starterTileNames(cat)].filter(
    (t) => !cat.tileExists(t) && !fromMaps.has(t),
  );
  assert.deepEqual(missing, [], `unknown tiles: ${missing.join(', ')}`);
});

test('a built-in building is a sealed box with exactly one door', { skip }, () => {
  const cat = catalogue();
  const kit = kitFromTileset(cat, KITS.house);
  const s = makeBuilding('test', 'house', kit, ['floors_interior_tilesandwood_01_0', 'floors_interior_carpet_01_0'], 6, 5);

  assert.equal(s.w, 7, 'grid is the interior plus the east margin');
  assert.equal(s.h, 6, 'grid is the interior plus the south margin');

  const wallAt = (x, y) => {
    const t = s.get('Furniture', x, y);
    return !!t && cat.isWall(t);
  };

  for (let x = 0; x < 6; x++) {
    assert.ok(wallAt(x, 0), `no north wall at x=${x}`);
    assert.ok(wallAt(x, 5), `no south wall at x=${x}`);
  }
  for (let y = 0; y < 5; y++) {
    assert.ok(wallAt(0, y), `no west wall at y=${y}`);
    assert.ok(wallAt(6, y), `no east wall at y=${y}`);
  }

  let doors = 0;
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const t = s.get('Furniture', x, y);
      if (t && cat.role(t)?.kind === 'door') {
        doors++;
        assert.equal(y, 5, 'the door should be on the south wall');
      }
    }
  }
  assert.equal(doors, 1, 'a building needs exactly one way in');

  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 6; x++) assert.ok(s.get('Floor', x, y), `no floor at ${x},${y}`);
  }
});

test('built-in buildings survive rotation', { skip }, () => {
  const cat = catalogue();
  for (const { schematic } of buildStarterLibrary(cat)) {
    const isWall = (t) => !!t && cat.isWall(t);
    const before = schematic.layers.get('Furniture').filter(isWall).length;

    const r = rotate(schematic, cat, 1);
    assert.equal(r.w, schematic.h, `${schematic.name} width`);
    assert.equal(r.h, schematic.w, `${schematic.name} height`);
    assert.ok(
      r.layers.get('Furniture').filter(isWall).length >= before,
      `${schematic.name} lost walls when rotated`,
    );

    let round = schematic;
    for (let i = 0; i < 4; i++) round = rotate(round, cat, 1);
    assert.equal(round.w, schematic.w, `${schematic.name} did not come back`);
    assert.equal(round.h, schematic.h, `${schematic.name} did not come back`);
  }
});

test('the built-in library covers the classes a town needs', { skip }, () => {
  const lib = new Library(null, catalogue());
  assert.ok(lib.size >= 15, `only ${lib.size} built-in buildings`);
  for (const cls of ['house', 'shed', 'garage', 'retail', 'grocery', 'office', 'warehouse']) {
    assert.ok(lib.count(cls) > 0, `no built-in ${cls}`);
  }
});

test('Library.open falls back to the built-in set', { skip }, () => {
  const lib = Library.open('/definitely/not/a/library', { cat: catalogue() });
  assert.equal(lib.source, 'starter');
  assert.ok(lib.size > 0);
});
