/**
 * Full-fidelity buildings, and rotating them.
 *
 * The worldgen prefab route flattened every building to its ground floor and four of
 * its twelve tiles, which is why they arrived with no roof. This path keeps everything,
 * so the thing worth testing is that "everything" survives the one transform applied to
 * it — a building is placed at one of four orientations, and a rotation that quietly
 * drops a wall produces a house you can walk into through the side.
 *
 * The invariant is `rotate x4 == identity`. It is checked two ways, because they catch
 * different faults:
 *
 *   - **the tile multiset**, which catches anything actually lost;
 *   - **square by square, up to corner form**, which catches anything that moved.
 *
 * "Up to corner form" is not a fudge. Rotation splits a corner tile into the two walls
 * it draws, sends them to two different squares — they are two different lattice edges —
 * and rejoins them wherever a pair meets again. Vanilla's own data is inconsistent about
 * which form it uses, so the count of tiles per square legitimately differs while the
 * walls drawn do not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { indexCell, readBuilding, cellSource, blockTiles, filterMargin, MARGIN } from '../src/extract/building.js';
import { rotateBlock, wallFacing, cornerParts } from '../src/prefab/block.js';
import { readCell, listCells } from '../src/formats/cell.js';
import { loadTileCatalogue } from '../src/formats/tiledefs.js';
import { findInstall } from '../src/lib/pzinstall.js';

let install = null;
try {
  install = findInstall();
} catch {
  install = null;
}
const skip = install ? false : 'no Project Zomboid install found';
const cat = install ? loadTileCatalogue(install) : null;
const MAP = install ? `${install}/media/maps/Muldraugh, KY` : null;

/** Every building from a spread of cells, so the sample is not one neighbourhood. */
function sample(limit = 400, stride = 17) {
  const src = cellSource(24, cat);
  const out = [];
  const cells = listCells(MAP);
  for (let i = 0; i < cells.length && out.length < limit; i += stride) {
    const { cx, cy } = cells[i];
    let refs;
    try {
      refs = indexCell(readCell(MAP, cx, cy), { map: 'M', mapDir: MAP, cx, cy });
    } catch {
      continue;
    }
    for (const ref of refs) {
      if (out.length >= limit) break;
      out.push(readBuilding(ref, src));
    }
  }
  return out;
}

/** A corner tile stands for the two walls it draws. */
const expand = (t) => {
  const parts = cornerParts(cat, t);
  return parts ? [parts.north, parts.west] : [t];
};

function tileBag(block) {
  const bag = new Map();
  for (let level = block.minLevel; level <= block.maxLevel; level++) {
    for (let y = 0; y < block.h; y++) {
      for (let x = 0; x < block.w; x++) {
        for (const t of blockTiles(block, x, y, level) ?? []) {
          for (const e of expand(t)) bag.set(e, (bag.get(e) ?? 0) + 1);
        }
      }
    }
  }
  return bag;
}

const squareKey = (block, x, y, level) =>
  (blockTiles(block, x, y, level) ?? []).flatMap(expand).sort().join('|');

test('buildings are read with every level, not just the rooms\' levels', { skip }, () => {
  // A roof is not a room, so `buildingBounds` reports a bungalow as single-storey.
  // Reading only those levels is exactly what lost every roof in the corpus.
  const blocks = sample(60);
  assert.ok(blocks.length > 20, `only ${blocks.length} buildings sampled`);

  let withRoof = 0;
  let aboveRoomLevels = 0;
  for (const block of blocks) {
    let roof = false;
    let above = false;
    for (let level = block.minLevel; level <= block.maxLevel; level++) {
      for (let y = 0; y < block.h && !roof; y++) {
        for (let x = 0; x < block.w && !roof; x++) {
          for (const t of blockTiles(block, x, y, level) ?? []) {
            if (/^roofs?_|^ceilings_/i.test(t)) roof = true;
          }
        }
      }
      if (level > block.ref.levels[1]) {
        for (let y = 0; y < block.h && !above; y++) {
          for (let x = 0; x < block.w && !above; x++) {
            if (blockTiles(block, x, y, level)?.length) above = true;
          }
        }
      }
    }
    if (roof) withRoof++;
    if (above) aboveRoomLevels++;
  }

  assert.ok(withRoof > blocks.length * 0.5, `only ${withRoof}/${blocks.length} buildings have roof or ceiling tiles`);
  assert.ok(
    aboveRoomLevels > blocks.length * 0.5,
    `only ${aboveRoomLevels}/${blocks.length} carry tiles above the level their rooms claim — ` +
      'this is the roof, and reading minLevel..maxLevel would lose it',
  );
});

test('rotating four times loses nothing at all', { skip }, () => {
  for (const block of sample()) {
    let turned = block;
    for (let i = 0; i < 4; i++) turned = rotateBlock(turned, cat, 1);

    const before = tileBag(block);
    const after = tileBag(turned);
    let delta = 0;
    for (const [tile, n] of before) delta += Math.abs(n - (after.get(tile) ?? 0));
    for (const [tile, n] of after) if (!before.has(tile)) delta += n;
    assert.equal(delta, 0, `${block.ref.id}: ${delta} tiles differ after four quarter-turns`);
  }
});

test('rotating four times puts everything back where it was', { skip }, () => {
  for (const block of sample()) {
    let turned = block;
    for (let i = 0; i < 4; i++) turned = rotateBlock(turned, cat, 1);

    assert.equal(turned.w, block.w, `${block.ref.id}: width changed`);
    assert.equal(turned.h, block.h, `${block.ref.id}: height changed`);

    for (let level = block.minLevel; level <= block.maxLevel; level++) {
      for (let y = 0; y < block.h; y++) {
        for (let x = 0; x < block.w; x++) {
          assert.equal(
            squareKey(turned, x, y, level),
            squareKey(block, x, y, level),
            `${block.ref.id}: square ${x},${y} at level ${level} changed`,
          );
        }
      }
    }
  }
});

test('one turn transposes the footprint and keeps the levels', { skip }, () => {
  for (const block of sample(80)) {
    const turned = rotateBlock(block, cat, 1);
    assert.equal(turned.w, block.h, `${block.ref.id}: rotated width`);
    assert.equal(turned.h, block.w, `${block.ref.id}: rotated height`);
    assert.equal(turned.minLevel, block.minLevel);
    assert.equal(turned.maxLevel, block.maxLevel);
    assert.equal(turned.dropped ?? 0, 0, `${block.ref.id}: rotation dropped tiles`);
  }
});

test('rooms rotate with the building', { skip }, () => {
  for (const block of sample(80)) {
    if (!block.rooms.length) continue;
    let turned = block;
    for (let i = 0; i < 4; i++) turned = rotateBlock(turned, cat, 1);
    assert.equal(turned.rooms.length, block.rooms.length, `${block.ref.id}: room count`);
    for (let i = 0; i < block.rooms.length; i++) {
      assert.equal(turned.rooms[i].name, block.rooms[i].name);
      assert.equal(turned.rooms[i].level, block.rooms[i].level);
      assert.deepEqual(
        turned.rooms[i].rects,
        block.rooms[i].rects,
        `${block.ref.id}: room "${block.rooms[i].name}" did not return`,
      );
    }
  }
});

test('the margin keeps only the walls that are real lattice edges', { skip }, () => {
  // A north wall at cell (x,y) is the edge (x,y)-(x+1,y), so it needs x <= iw-1;
  // a west wall is (x,y)-(x,y+1), so it needs y <= ih-1. The square at (iw,ih) can
  // hold neither. Leaving one there survives the first quarter-turn and vanishes on
  // the second, which is the worst kind of bug to find in a game.
  const northWall = 'walls_exterior_house_01_1';
  const westWall = 'walls_exterior_house_01_0';
  assert.equal(wallFacing(cat, northWall), 'N', 'test fixture is not a north wall');
  assert.equal(wallFacing(cat, westWall), 'W', 'test fixture is not a west wall');

  const both = [northWall, westWall, 'floors_exterior_street_01_14'];
  assert.deepEqual(filterMargin(both, cat, { onSouthEdge: true, onEastEdge: false }), [northWall]);
  assert.deepEqual(filterMargin(both, cat, { onSouthEdge: false, onEastEdge: true }), [westWall]);
  assert.deepEqual(filterMargin(both, cat, { onSouthEdge: true, onEastEdge: true }), []);
});

test('buildings straddling a cell boundary are kept, not dropped', { skip }, () => {
  // harvest.js drops these because a prefab has to come out of one file. 6.2% of the
  // corpus. Here the reader simply opens the neighbouring cell too.
  const src = cellSource(24, cat);
  let straddling = 0;
  let read = 0;
  const cells = listCells(MAP);
  for (let i = 0; i < cells.length && straddling < 5; i += 11) {
    const { cx, cy } = cells[i];
    let refs;
    try {
      refs = indexCell(readCell(MAP, cx, cy), { map: 'M', mapDir: MAP, cx, cy });
    } catch {
      continue;
    }
    for (const ref of refs) {
      if (ref.x + ref.w <= 256 && ref.y + ref.h <= 256) continue;
      straddling++;
      const block = readBuilding(ref, src);
      // The half past the boundary must have come from the next cell along.
      let beyond = 0;
      for (let level = block.minLevel; level <= block.maxLevel; level++) {
        for (let y = 0; y < block.h; y++) {
          for (let x = 0; x < block.w; x++) {
            if (ref.x + x < 256 && ref.y + y < 256) continue;
            if (blockTiles(block, x, y, level)?.length) beyond++;
          }
        }
      }
      if (beyond > 0) read++;
      if (straddling >= 5) break;
    }
  }
  assert.ok(straddling > 0, 'no straddling buildings found to test');
  assert.equal(read, straddling, 'a straddling building read nothing from the neighbouring cell');
});

test('MARGIN is one square, and the reference carries it', { skip }, () => {
  assert.equal(MARGIN, 1);
  const src = cellSource(4, cat);
  const refs = indexCell(readCell(MAP, 51, 7), { map: 'M', mapDir: MAP, cx: 51, cy: 7 });
  const block = readBuilding(refs[0], src);
  assert.equal(block.w, refs[0].w);
  assert.equal(block.h, refs[0].h);
});
