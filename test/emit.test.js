/**
 * Writing cells, chunkdata and street names.
 *
 * Everything the format tests do today round-trips a cell the reader has just read.
 * That proves the codec and nothing about a cell we *built*, which is the only kind the
 * generator produces. So these tests synthesise cells and read them back with the same
 * readers the game's data goes through.
 *
 * Two of the assertions here are load-bearing rather than tidy, because the game fails
 * silently on both:
 *
 *   - a chunk that is not completely full at level 0 is handed back to the procedural
 *     generator, taking everything authored in it with it;
 *   - a street record the parser rejects throws out of the map screen and there is no
 *     map at all, not just no label.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CellBuilder, CellGrid, ZOMBIE_ROOFED, ZOMBIE_DENSE } from '../src/emit/lotpack.js';
import { encodeChunkData, decodeChunkData, computeChunkBits, BIT_SOLID, BIT_ROOM } from '../src/emit/chunkdata.js';
import { plantAt, vegetationFields, PLANTABLE, DENSITY_WILD } from '../src/plan/vegetation.js';
import { toStreets, encodeStreetsXml, escapeXml, MAX_POINTS } from '../src/emit/streets.js';
import { planParking, encodeObjectsLua } from '../src/emit/objects.js';
import { SurfaceGrid, writeBiomeMaps } from '../src/emit/world.js';
import { decodePng } from '../src/formats/png.js';
import { Noise } from '../src/lib/noise.js';
import { baseTile } from '../src/plan/blends.js';
import { decayAt } from '../src/plan/decay.js';
import { readCell } from '../src/formats/cell.js';
import { CELL_SIZE, CHUNK_SIZE } from '../src/formats/lotheader.js';
import { findInstall } from '../src/lib/pzinstall.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pzw-emit-'));
}

// ---------------------------------------------------------------- chunkdata

test('chunkdata encodes and decodes its own output', () => {
  const bits = new Uint8Array(CELL_SIZE * CELL_SIZE);
  for (let i = 0; i < bits.length; i++) {
    bits[i] = i % 977 === 0 ? 7 : i % 13 === 0 ? 1 : 0;
  }
  const encoded = encodeChunkData(bits);
  const decoded = decodeChunkData(encoded);
  assert.equal(decoded.consumed, encoded.length, 'left bytes unread');
  assert.deepEqual(Array.from(decoded.bits), Array.from(bits));
});

test('an empty cell is the 1,026-byte wilderness form the canvas already ships', () => {
  const encoded = encodeChunkData(new Uint8Array(CELL_SIZE * CELL_SIZE));
  assert.equal(encoded.length, 2 + 1024, 'a uniform cell should be a type byte per chunk');
  assert.equal(encoded.readInt16BE(0), 1, 'version is a BIG-endian short');
});

test('every shipped chunkdata file decodes with nothing left over', () => {
  let install;
  try {
    install = findInstall();
  } catch {
    return; // no install; the format tests already skip in this case
  }
  const dir = path.join(install, 'media/maps/Muldraugh, KY');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('chunkdata_'));
  assert.ok(files.length > 100, `expected shipped chunkdata, found ${files.length}`);

  let checked = 0;
  for (let i = 0; i < files.length; i += 97) {
    const buf = fs.readFileSync(path.join(dir, files[i]));
    const decoded = decodeChunkData(buf);
    assert.equal(decoded.consumed, buf.length, `${files[i]}: ${buf.length - decoded.consumed} bytes left over`);
    checked++;
  }
  assert.ok(checked > 5, `only ${checked} files checked`);
});

test('a square with no floor is marked solid', () => {
  const builder = new CellBuilder(0, 0);
  builder.putSquare(5, 5, 0, ['blends_natural_01_16']);
  const bits = computeChunkBits(builder.finish());
  assert.equal(bits[5 * CELL_SIZE + 5] & BIT_SOLID, 0, 'a square with a floor is not solid');
  assert.equal(bits[6 * CELL_SIZE + 5] & BIT_SOLID, BIT_SOLID, 'an empty square should be solid');
});

// ------------------------------------------------------------- cell writing

test('a synthesised cell reads back with its levels, tiles and rooms', () => {
  const dir = tmpdir();
  try {
    const builder = new CellBuilder(3, 4, { minLevel: 0, maxLevel: 7 });

    // A floor everywhere in one chunk, walls on level 0, a roof on level 1.
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        builder.putSquare(x, y, 0, ['blends_natural_01_16']);
      }
    }
    builder.setSquare(2, 2, 0, ['walls_exterior_house_01_1', 'walls_exterior_house_01_0']);
    builder.setSquare(2, 2, 1, ['roofs_02_80']);
    builder.setSquare(3, 2, 7, ['roofs_02_81']);

    const roomA = builder.addRoom({ name: 'kitchen', level: 0, rects: [[2, 2, 3, 3]], objects: [] });
    const roomB = builder.addRoom({ name: 'emptyoutside', level: 0, rects: [[1, 1, 6, 6]], objects: [] });
    builder.addBuilding([roomA, roomB]);
    builder.write(dir);

    const cell = readCell(dir, 3, 4);
    assert.equal(cell.header.minLevel, 0);
    assert.equal(cell.header.maxLevel, 7, 'a cell must declare all eight levels for upper storeys');
    assert.equal(cell.levels, 8);

    assert.deepEqual(cell.tileNames(3, 2, 7), ['roofs_02_81'], 'level 7 did not survive');
    assert.deepEqual(cell.tileNames(2, 2, 1), ['roofs_02_80'], 'the roof did not survive');
    assert.deepEqual(cell.tileNames(2, 2, 0), [
      'blends_natural_01_16',
      'walls_exterior_house_01_1',
      'walls_exterior_house_01_0',
    ], 'tiles should accumulate on a square, not replace');

    assert.equal(cell.header.rooms.length, 2);
    assert.equal(cell.header.rooms[0].name, 'kitchen');
    assert.deepEqual(cell.header.rooms[0].rects, [[2, 2, 3, 3]]);
    assert.equal(cell.header.buildings.length, 1);
    assert.deepEqual(cell.header.buildings[0], [0, 1]);

    // Every tile index must resolve, or the game draws blanks with no error.
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        for (const t of cell.square(x, y, 0)?.tiles ?? []) {
          assert.ok(cell.header.tiles[t], `tile index ${t} does not resolve`);
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a basement keeps its tiles and its room, and the cell declares the level', () => {
  const dir = tmpdir();
  try {
    const builder = new CellBuilder(3, 4);
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) builder.putSquare(x, y, 0, ['blends_natural_01_16']);
    }
    builder.setSquare(2, 2, -1, ['floors_interior_carpet_01_0']);
    builder.addRoom({ name: 'basement', level: -1, rects: [[2, 2, 2, 2]], objects: [] });
    builder.write(dir);

    const cell = readCell(dir, 3, 4);
    assert.equal(cell.header.minLevel, -1, 'the cell must declare the level its basement is on');
    assert.equal(cell.header.maxLevel, 0, 'and no more than it needs — 3,068 Muldraugh cells are 0..0');
    assert.deepEqual(cell.tileNames(2, 2, -1), ['floors_interior_carpet_01_0'], 'the basement floor was dropped');
    assert.ok(cell.square(2, 2, 0), 'the ground floor must survive the level shift');

    // A RoomDef outside the declared range is a room with no squares under it.
    for (const room of cell.header.rooms) {
      assert.ok(
        room.level >= cell.header.minLevel && room.level <= cell.header.maxLevel,
        `room "${room.name}" is on level ${room.level}, outside ${cell.header.minLevel}..${cell.header.maxLevel}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a room below the tiles still widens the cell, so no room floats outside its range', () => {
  const builder = new CellBuilder(0, 0);
  builder.putSquare(0, 0, 0, ['blends_natural_01_16']);
  builder.addRoom({ name: 'basement', level: -4, rects: [[0, 0, 2, 2]], objects: [] });
  const cell = builder.finish();
  assert.equal(cell.header.minLevel, -4);
  assert.equal(cell.header.maxLevel, 0);
});

test('a partly filled chunk is reported, because the game would silently discard it', () => {
  const builder = new CellBuilder(0, 0);
  assert.deepEqual(builder.incompleteChunks(), [], 'an untouched cell has no incomplete chunks');

  builder.putSquare(0, 0, 0, ['blends_natural_01_16']);
  const holes = builder.incompleteChunks();
  assert.equal(holes.length, 1, 'one square in a chunk leaves that chunk incomplete');
  assert.equal(holes[0].filled, 1);

  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) builder.putSquare(x, y, 0, ['blends_natural_01_16']);
  }
  assert.deepEqual(builder.incompleteChunks(), [], 'a full chunk should be accepted');
});

test('a grid puts world squares in the right cells and rooms in the owning one', () => {
  const grid = new CellGrid();
  grid.putSquare(CELL_SIZE + 5, 2 * CELL_SIZE + 7, 0, ['blends_natural_01_16']);
  const builder = grid.at(1, 2);
  assert.ok(builder.hasSquare(5, 7, 0), 'the square landed in the wrong cell');

  // A building at the very edge keeps all of its rooms in one cell, overflowing
  // past the boundary exactly as the shipped maps do.
  grid.addBuilding(2 * CELL_SIZE - 4, 2 * CELL_SIZE - 4, [
    { name: 'livingroom', level: 0, rects: [[0, 0, 10, 10]], objects: [] },
  ]);
  const owner = grid.at(1, 1);
  assert.equal(owner.rooms.length, 1, 'the room should belong to the cell holding its corner');
  assert.deepEqual(owner.rooms[0].rects, [[CELL_SIZE - 4, CELL_SIZE - 4, 10, 10]]);
  assert.ok(owner.rooms[0].rects[0][0] + owner.rooms[0].rects[0][2] > CELL_SIZE, 'this rect should overflow the cell');
});

test('a chunk with buildings over it carries a zombie intensity, and empty ground does not', () => {
  const builder = new CellBuilder(0, 0);
  for (let y = 0; y < CELL_SIZE; y++) {
    for (let x = 0; x < CELL_SIZE; x++) builder.putSquare(x, y, 0, ['blends_natural_01_16']);
  }
  // A building filling more than half of chunk 0,0 and a corner of chunk 1,0.
  builder.addRoom({ name: 'kitchen', level: 0, rects: [[0, 0, 8, 6]], objects: [] });
  builder.addRoom({ name: 'shed', level: 0, rects: [[8, 0, 2, 2]], objects: [] });
  const cell = builder.finish();

  // Zero everywhere is what the native population layer reads as "no zombies here",
  // and it is what every generated city shipped before this.
  assert.equal(cell.header.density[0], ZOMBIE_DENSE, 'a chunk more than half roofed reads the dense value');
  assert.equal(cell.header.density[1], ZOMBIE_ROOFED, 'a lightly roofed chunk reads the roofed value');
  assert.equal(cell.header.density[5], 0, 'open ground carries nothing, as 84% of vanilla does');
  assert.ok(cell.header.density.some((v) => v > 0), 'the whole block must not be zero');
});

test('grass outside the town is forest, not TownZone', () => {
  const dir = tmpdir();
  try {
    const surfaces = new SurfaceGrid({ minX: 0, minY: 0, maxX: CELL_SIZE - 1, maxY: CELL_SIZE - 1 });
    surfaces.fill('grass');
    const grid = new CellGrid();
    grid.putSquare(0, 0, 0, ['blends_natural_01_16']);

    // Only the left half is built up.
    writeBiomeMaps(surfaces, grid, dir, () => {}, (x) => x < 128);
    const png = decodePng(fs.readFileSync(path.join(dir, 'maps', 'biomemap_0_0.png')));

    assert.equal(png.pixels[10], 115, 'town grass is TownZone/townhouse');
    assert.equal(png.pixels[200], 255, 'grass outside the town is primary_forest');
    // 64 spawns nothing at all: it has no `biome` key in BiomeMapConfig.lua.
    assert.ok(!png.pixels.includes(64), 'no square may be left on a biome that grows nothing');
    assert.ok(!png.pixels.includes(96), '$random squares are discarded by genMapSquare');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('squares inside a room carry the chunkdata room bit', () => {
  const builder = new CellBuilder(0, 0);
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) builder.putSquare(x, y, 0, ['blends_natural_01_16']);
  }
  builder.addRoom({ name: 'kitchen', level: 0, rects: [[2, 2, 3, 3]], objects: [] });
  const bits = computeChunkBits(builder.finish(), builder.roomMask());

  // Vanilla sets bit 16 exactly on the room rectangles — 533 of 533 in Muldraugh
  // cell 38_30. Leaving it zero tells the native population layer the city is
  // entirely outdoors.
  assert.equal(bits[3 * CELL_SIZE + 3] & BIT_ROOM, BIT_ROOM, 'inside the room rect');
  assert.equal(bits[7 * CELL_SIZE + 7] & BIT_ROOM, 0, 'outside it');
});

test('noise arranges vegetation into stands without changing how much there is', () => {
  const fields = vegetationFields('seed');
  const side = 600;
  let planted = 0;
  let rocks = 0;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const t = plantAt(x, y, DENSITY_WILD, 'seed', fields);
      if (!t) continue;
      if (t.startsWith('boulders')) rocks++;
      else planted++;
    }
  }
  const n = side * side;
  const rate = planted / n;

  // The mean is vanilla's; only the arrangement is noise. 2*fbm has mean ~1, so
  // modulating by it must not move the total by much.
  assert.ok(
    Math.abs(rate - DENSITY_WILD) < 0.04,
    `expected about ${DENSITY_WILD}, got ${rate.toFixed(3)}`,
  );
  assert.ok(rocks > 0 && rocks / n < 0.01, `boulders should be rare, got ${(rocks / n).toFixed(4)}`);

  // Clumped, not evenly scattered: the densest 60-square block should be well ahead
  // of the sparsest. A flat probability makes these nearly equal.
  const blocks = [];
  for (let by = 0; by + 60 <= side; by += 60) {
    for (let bx = 0; bx + 60 <= side; bx += 60) {
      let c = 0;
      for (let y = by; y < by + 60; y++) {
        for (let x = bx; x < bx + 60; x++) if (plantAt(x, y, DENSITY_WILD, 'seed', fields)) c++;
      }
      blocks.push(c / 3600);
    }
  }
  blocks.sort((a, b) => a - b);
  const lo = blocks[0];
  const hi = blocks[blocks.length - 1];
  assert.ok(hi > lo * 2, `expected stands and clearings, got ${lo.toFixed(3)}..${hi.toFixed(3)}`);

  // Deterministic: the same city rebuilds as the same city.
  assert.equal(
    plantAt(41, 17, DENSITY_WILD, 'seed', fields),
    plantAt(41, 17, DENSITY_WILD, 'seed', vegetationFields('seed')),
  );
  // Tarmac and pavement are not plantable surfaces.
  assert.ok(!PLANTABLE.has('road') && !PLANTABLE.has('pavement'));
  assert.ok(PLANTABLE.has('grass'));
});

test('ground variants come down in patches, not as a per-square dither', () => {
  const set = { sheet: 'blends_natural_01', base: 16, variants: [0, 5, 6, 7] };
  const texture = new Noise('texture:test');

  const runLength = (useNoise) => {
    const runs = [];
    let cur = null;
    let len = 0;
    for (let x = 0; x < 3000; x++) {
      const t = baseTile(set, x, 500, useNoise ? texture : null);
      if (t === cur) len++;
      else {
        if (cur !== null) runs.push(len);
        cur = t;
        len = 1;
      }
    }
    return runs.reduce((a, b) => a + b, 0) / runs.length;
  };

  // Choosing from a per-square hash gives a run length of 1 — every square a different
  // variant, which reads as a uniform dither over a whole city rather than as ground.
  assert.ok(runLength(false) < 2, 'the hash fallback should be per-square');
  assert.ok(runLength(true) > 20, `expected broad patches, got ${runLength(true).toFixed(1)} squares`);
});

test('road wear is patchy and covers a visible share of the tarmac', () => {
  const field = new Noise('wear:test');
  let hit = 0;
  let n = 0;
  const blocks = [];
  for (let by = 0; by < 480; by += 60) {
    for (let bx = 0; bx < 480; bx += 60) {
      let c = 0;
      for (let y = by; y < by + 60; y++) {
        for (let x = bx; x < bx + 60; x++) {
          n++;
          if (decayAt(x, y, field, 's')) {
            hit++;
            c++;
          }
        }
      }
      blocks.push(c / 3600);
    }
  }
  const rate = hit / n;
  // The first attempt stained 347 squares out of 1.9 million because the fBm field
  // never reached the threshold. Anything near zero is the feature not existing.
  assert.ok(rate > 0.02 && rate < 0.2, `expected a visible but not total wear rate, got ${rate.toFixed(3)}`);
  blocks.sort((a, b) => a - b);
  assert.ok(
    blocks[blocks.length - 1] > blocks[0] * 3,
    'wear should pool in patches, not speckle evenly',
  );
});

// ----------------------------------------------------------------- streets

test('street records carry names, widths and absolute coordinates', () => {
  const streets = toStreets([
    { name: 'Oak St', cls: 'residential', points: [[100, 200], [100, 300]] },
    { name: '', cls: 'residential', points: [[0, 0], [1, 1]] },
    { cls: 'residential', points: [[0, 0], [1, 1]] },
    { name: 'Stub', cls: 'residential', points: [[5, 5]] },
  ]);
  assert.equal(streets.length, 1, 'unnamed and single-point ways must be dropped');
  assert.equal(streets[0].name, 'Oak St');
  assert.equal(streets[0].width, 6);

  const { xml, written } = encodeStreetsXml(streets);
  assert.equal(written, 1);
  assert.match(xml, /^<streets version="1">/);
  assert.match(xml, /<street name="Oak St" width="6">/);
  assert.match(xml, /<point x="100\.0" y="200\.0"\/>/, 'coordinates are floats to one place');
  assert.match(xml, /<\/streets>\n$/);
});

test('a long street is cut rather than dropped', () => {
  const points = Array.from({ length: MAX_POINTS * 2 + 10 }, (_, i) => [i, i]);
  const streets = toStreets([{ name: 'Long Road', cls: 'primary', points }]);
  assert.ok(streets.length >= 3, `expected the street to be cut, got ${streets.length} pieces`);
  for (const s of streets) {
    assert.ok(s.points.length >= 2 && s.points.length <= MAX_POINTS, `piece has ${s.points.length} points`);
    assert.equal(s.name, 'Long Road');
  }
  // The pieces must join up, or the label breaks mid-street.
  for (let i = 1; i < streets.length; i++) {
    assert.deepEqual(streets[i].points[0], streets[i - 1].points[streets[i - 1].points.length - 1]);
  }
});

test('a name the parser would choke on is escaped, not passed through', () => {
  // The parser throws on malformed XML and takes the whole map screen with it, and
  // OpenStreetMap names really do contain ampersands and quotes.
  assert.equal(escapeXml(`Bell & Sons "Way"`), 'Bell &amp; Sons &quot;Way&quot;');
  const { xml } = encodeStreetsXml(toStreets([{ name: 'A & B <Road>', cls: 'primary', points: [[1, 1], [2, 2]] }]));
  assert.ok(!/name="[^"]*[<&][^"]*"/.test(xml.replace(/&\w+;/g, '')), 'raw markup survived into an attribute');
  assert.match(xml, /name="A &amp; B &lt;Road&gt;"/);
});

// ----------------------------------------------------------------- objects

test('parking stalls are car-sized, on pavement, and never inside a building', () => {
  const surfaces = new SurfaceGrid({ minX: 0, minY: 0, maxX: 63, maxY: 63 });
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) surfaces.set(x, y, 'road');
  }
  // A building standing on the paved area. No stall may touch it.
  const placements = [{ x: 10, y: 10, w: 12, h: 12 }];

  const stalls = planParking({
    surfaces,
    cover: [{ pixel: 200, points: [[0, 0], [40, 0], [40, 40], [0, 40]] }],
    roads: [],
    placements,
  });
  assert.ok(stalls.length > 5, `expected a lot to be tiled, got ${stalls.length}`);

  for (const s of stalls) {
    const sizes = [`${s.width}x${s.height}`];
    assert.ok(sizes[0] === '3x5' || sizes[0] === '5x3', `a stall should be one car, got ${sizes[0]}`);
    for (let dy = 0; dy < s.height; dy++) {
      for (let dx = 0; dx < s.width; dx++) {
        const x = s.x + dx;
        const y = s.y + dy;
        assert.equal(surfaces.get(x, y), 'road', `stall square ${x},${y} is not paved`);
        const b = placements[0];
        assert.ok(
          x < b.x || x >= b.x + b.w || y < b.y || y >= b.y + b.h,
          `stall square ${x},${y} is inside a building`,
        );
      }
    }
  }
});

test('objects.lua assigns the global metazoneHandler reloads, with integer coordinates', () => {
  const lua = encodeObjectsLua([
    { name: '', type: 'ParkingStall', x: 10.6, y: 20.4, z: 0, width: 3, height: 5 },
  ]);
  assert.match(lua, /^objects = \{\n/, 'the handler does `objects = {}` then reloads this file');
  assert.match(lua, /\{ name = "", type = "ParkingStall", x = 11, y = 20, z = 0, width = 3, height = 5 \},/);
  assert.match(lua, /\}\n$/);
  assert.ok(!/\d\.\d/.test(lua), 'a float reaches registerVehiclesZone(int, int, ...) and is truncated silently');
});

test('nothing invalid reaches the file even if a caller builds it by hand', () => {
  const { written } = encodeStreetsXml([
    { name: 'Fine', width: 6, points: [[1, 1], [2, 2]] },
    { name: '   ', width: 6, points: [[1, 1], [2, 2]] },
    { name: 'No points', width: 6, points: [] },
    { name: 'One point', width: 6, points: [[1, 1]] },
    { name: 'NaN', width: 6, points: [[Number.NaN, 1], [2, 2]] },
  ]);
  assert.equal(written, 1, 'only the valid record should be written');
});
