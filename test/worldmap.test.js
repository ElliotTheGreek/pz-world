/**
 * `worldmap.xml.bin` against the game's own files.
 *
 * The map screen was blank because pz-world shipped only `worldmap.xml`, and
 * `WorldMapXML` — the reader vanilla never uses, because every shipped map has
 * a `.bin` beside it — passes a count of *shorts* where `WorldMapPoints` wants
 * a count of *points*, so it walks twice as far as it wrote and throws out of
 * every feature. See src/formats/worldmap.js.
 *
 * The replacement has to be exactly right first time: a wrong field width does
 * not produce an error, it produces a map with the buildings in the wrong
 * place. So the reader is checked against all six binaries the game ships, and
 * the writer has to reproduce each of them byte for byte.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  decodeWorldMapBin,
  encodeWorldMapBin,
  parseWorldMapXml,
  compileWorldMapXml,
  encodeWorldMapXml,
  assertXmlMatchesBin,
  CELL_SIZE,
} from '../src/formats/worldmap.js';
import { findInstall } from '../src/lib/pzinstall.js';

function shippedBinaries() {
  const root = path.join(findInstall(), 'media/maps');
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.xml.bin')) out.push(p);
    }
  };
  walk(root);
  return out;
}

const BINARIES = shippedBinaries();

test('the game ships a worldmap binary for every map, which is why the XML path is dead', () => {
  assert.ok(BINARIES.length >= 6, `expected the shipped worldmap binaries, found ${BINARIES.length}`);
});

test('every shipped worldmap binary reads', () => {
  for (const file of BINARIES) {
    const doc = decodeWorldMapBin(fs.readFileSync(file));
    const name = path.basename(path.dirname(file));

    assert.ok(doc.width > 0 && doc.height > 0, `${name}: empty grid`);
    assert.ok(doc.cells.length > 0, `${name}: no cells`);
    assert.ok(doc.cells.length <= doc.width * doc.height, `${name}: more cells than records`);

    for (const cell of doc.cells) {
      // Every cell must fall inside the declared grid, or the writer would have
      // nowhere to put it back.
      assert.ok(cell.x >= doc.originX && cell.x < doc.originX + doc.width, `${name}: cell x outside the grid`);
      assert.ok(cell.y >= doc.originY && cell.y < doc.originY + doc.height, `${name}: cell y outside the grid`);
      for (const f of cell.features) {
        assert.ok(f.rings.length > 0, `${name}: feature with no coordinates`);
        for (const ring of f.rings) {
          assert.equal(ring.length % 2, 0, `${name}: odd coordinate count`);
          assert.ok(ring.length >= 2, `${name}: empty ring`);
        }
      }
    }
  }
});

test('the writer reproduces every shipped binary byte for byte', () => {
  for (const file of BINARIES) {
    const original = fs.readFileSync(file);
    const rewritten = encodeWorldMapBin(decodeWorldMapBin(original));
    assert.equal(rewritten.length, original.length, `${file}: length differs`);
    assert.ok(rewritten.equals(original), `${file}: bytes differ`);
  }
});

test('the grid origin is recovered, not guessed at', () => {
  // Muldraugh's forest map declares 78x63 records and has no cell above y=3,
  // because its first four rows are empty. Taking the lowest cell as the origin
  // would slide the entire map four cells north — and still round-trip, since
  // every cell carries its own absolute coordinates. Only the byte-exact test
  // above catches it, so this states the case directly.
  const forest = BINARIES.find((f) => f.includes('Muldraugh') && f.includes('forest'));
  if (!forest) return;
  const doc = decodeWorldMapBin(fs.readFileSync(forest));
  const lowestY = Math.min(...doc.cells.map((c) => c.y));
  assert.equal(doc.originY, 0, 'origin should be the grid start');
  assert.ok(lowestY > doc.originY, 'this file is only interesting if its first rows are empty');
});

test('a truncated file is rejected at the read, with an offset', () => {
  const original = fs.readFileSync(BINARIES[0]);
  assert.throws(
    () => decodeWorldMapBin(original.subarray(0, original.length - 8)),
    /truncated/,
    'a short file should be reported, not silently half-parsed',
  );
  assert.throws(() => decodeWorldMapBin(Buffer.from('nope')), /magic/);
});

test('cell size and version are the ones the game accepts', () => {
  const doc = decodeWorldMapBin(fs.readFileSync(BINARIES[0]));
  const encoded = encodeWorldMapBin(doc);
  assert.equal(encoded.readInt32LE(4), 2, 'version 1 is rejected by the game as Build 41');
  assert.equal(encoded.readInt32LE(8), CELL_SIZE);
});

test('the XML scanner reads what PZWorld/WorldMap.lua writes', () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<world version="1.0">',
    ' <cell x="31" y="33">',
    '  <feature>',
    '   <geometry type="Polygon">',
    '    <coordinates>',
    '     <point x="10" y="20"/>',
    '     <point x="30" y="20"/>',
    '     <point x="30" y="40"/>',
    '     <point x="10" y="40"/>',
    '    </coordinates>',
    '   </geometry>',
    '   <properties>',
    '    <property name="building" value="Residential"/>',
    '   </properties>',
    '  </feature>',
    ' </cell>',
    '</world>',
  ].join('\r\n');

  const doc = parseWorldMapXml(xml);
  assert.equal(doc.cells.length, 1);
  assert.deepEqual(doc.cells[0], {
    x: 31,
    y: 33,
    features: [
      {
        type: 'Polygon',
        rings: [[10, 20, 30, 20, 30, 40, 10, 40]],
        properties: [['building', 'Residential']],
      },
    ],
  });

  // ...and compiles to something the binary reader gets back unchanged.
  const round = decodeWorldMapBin(compileWorldMapXml(xml));
  assert.deepEqual(round.cells, doc.cells);
});

test('the XML scanner complains rather than dropping what it does not understand', () => {
  const bad = '<world version="1.0"> <cell x="1" y="1"><feature><properties/></feature></cell></world>';
  assert.throws(() => parseWorldMapXml(bad), /no <geometry>/);

  const unknownType =
    '<world version="1.0"> <cell x="1" y="1"><feature>' +
    '<geometry type="Blob"><coordinates><point x="1" y="1"/></coordinates></geometry>' +
    '</feature></cell></world>';
  assert.throws(() => parseWorldMapXml(unknownType), /unknown geometry type/);
});

test('a coordinate that will not fit in a short is refused, not wrapped', () => {
  const doc = {
    width: 1,
    height: 1,
    originX: 0,
    originY: 0,
    cells: [
      {
        x: 0,
        y: 0,
        features: [{ type: 'Polygon', rings: [[0, 0, 40000, 0, 0, 1]], properties: [] }],
      },
    ],
  };
  assert.throws(() => encodeWorldMapBin(doc), /does not fit in a short/);
});

test('a cell outside the declared grid is refused, not dropped', () => {
  const doc = {
    width: 1,
    height: 1,
    originX: 0,
    originY: 0,
    cells: [
      { x: 0, y: 0, features: [{ type: 'Polygon', rings: [[0, 0, 1, 0, 1, 1]], properties: [] }] },
      { x: 9, y: 9, features: [{ type: 'Polygon', rings: [[0, 0, 1, 0, 1, 1]], properties: [] }] },
    ],
  };
  assert.throws(() => encodeWorldMapBin(doc), /fall outside/);
});

/**
 * The blank-map failure, from both ends.
 *
 * A blank in-game map has been reported twice against builds whose cells were
 * perfectly good. Both times the map file next to them held no features, and
 * nothing anywhere said so: the build logged what it had written rather than
 * what was on disk, and `WorldMapDataAssetManager` loads an empty `.bin` without
 * complaint and simply draws nothing. These two pin the checks that turn that
 * into a message.
 */
test('a mod whose map data is empty is reported rather than passing quietly', async () => {
  const { verifyMod } = await import('../src/verify.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pzworld-blankmap-'));
  try {
    const mapDir = path.join(dir, 'common/media/maps/PZWorld');
    fs.mkdirSync(mapDir, { recursive: true });
    fs.mkdirSync(path.join(dir, '42'), { recursive: true });
    fs.writeFileSync(path.join(dir, '42/mod.info'), 'name=x\nid=x\n');
    fs.writeFileSync(path.join(mapDir, 'map.info'), 'title=PZWorld\n');
    fs.writeFileSync(path.join(mapDir, 'spawnpoints.lua'), 'function SpawnPoints() return {} end\n');
    fs.writeFileSync(path.join(mapDir, 'worldmap.xml'), '<world/>\n');
    // Exactly what an 80x80 canvas with nothing built on it encodes to, which is
    // the file that turned up beside a finished city.
    fs.writeFileSync(
      path.join(mapDir, 'worldmap.xml.bin'),
      encodeWorldMapBin({ width: 80, height: 80, originX: 0, originY: 0, cells: [] }),
    );

    const { problems } = verifyMod(dir);
    assert.ok(problems.some((p) => /worldmap\.xml\.bin has no features/.test(p)),
      `an empty map was not reported: ${problems.join('; ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the name both map screens look up is reported when it goes missing', async () => {
  const { verifyMod } = await import('../src/verify.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pzworld-noname-'));
  try {
    const mapDir = path.join(dir, 'common/media/maps/PZWorld');
    fs.mkdirSync(mapDir, { recursive: true });
    fs.mkdirSync(path.join(dir, '42'), { recursive: true });
    fs.writeFileSync(path.join(dir, '42/mod.info'), 'name=x\nid=x\n');
    fs.writeFileSync(path.join(mapDir, 'map.info'), 'title=PZWorld\n');
    fs.writeFileSync(path.join(mapDir, 'spawnpoints.lua'), 'function SpawnPoints() return {} end\n');
    // A perfectly good `.bin` and no `worldmap.xml`: `ZomboidFileSystem` builds
    // `activeFileMap` at mod-scan time, so with no name to find neither screen
    // ever asks for the data, however good it is.
    fs.writeFileSync(
      path.join(mapDir, 'worldmap.xml.bin'),
      encodeWorldMapBin({
        width: 2, height: 2, originX: 0, originY: 0,
        cells: [{ x: 0, y: 0, features: [{ type: 'Polygon', rings: [[0, 0, 8, 0, 8, 8, 0, 8]], properties: [['building', 'yes']] }] }],
      }),
    );

    const { problems } = verifyMod(dir);
    assert.ok(problems.some((p) => /worldmap\.xml is missing/.test(p)),
      `a missing map name was not reported: ${problems.join('; ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The XML and the binary beside it are the same map.
 *
 * The helper watches `worldmap.xml` and recompiles `worldmap.xml.bin` from it on
 * any change (`helper/serve.js compileMapIfChanged`), forcing the canvas
 * geometry as it goes. That makes the XML the real source of truth on disk
 * whatever the authored build wrote, and a build that leaves a *stub* there has
 * quietly replaced its own map with an empty one. These pin the round trip that
 * makes the two writers agree.
 */
test('the authored map survives being recompiled by the helper, byte for byte', () => {
  const doc = {
    width: 80,
    height: 80,
    originX: 0,
    originY: 0,
    cells: [
      { x: 29, y: 31, features: [
        { type: 'Polygon', rings: [[10, 10, 22, 10, 22, 20, 10, 20]], properties: [['building', 'Residential']] },
        { type: 'Polygon', rings: [[0, 40, 200, 40, 200, 46, 0, 46]], properties: [['highway', 'secondary']] },
      ] },
      { x: 50, y: 29, features: [
        { type: 'Polygon', rings: [[4, 4, 120, 8, 90, 200, 2, 150]], properties: [['natural', 'forest']] },
      ] },
    ],
  };

  const bin = encodeWorldMapBin(doc);
  const xml = encodeWorldMapXml(doc);
  // Exactly what the helper does, geometry and all.
  assertXmlMatchesBin(xml, bin, { width: 80, height: 80 });

  const back = parseWorldMapXml(xml, { width: 80, height: 80 });
  assert.equal(back.cells.length, doc.cells.length);
  assert.deepEqual(back.cells.map((c) => [c.x, c.y]), doc.cells.map((c) => [c.x, c.y]));
  assert.deepEqual(back.cells[0].features[0].rings, doc.cells[0].features[0].rings);
  assert.deepEqual(back.cells[0].features[0].properties, doc.cells[0].features[0].properties);
});

test('a property the XML reader could not decode is refused at the write', () => {
  const doc = {
    width: 4, height: 4, originX: 0, originY: 0,
    cells: [{ x: 1, y: 1, features: [
      { type: 'Polygon', rings: [[0, 0, 4, 0, 4, 4]], properties: [['building', 'Bob\'s "Diner" & Bar']] },
    ] }],
  };
  // `parseWorldMapXml` does no entity decoding, so a value carrying a quote
  // would read back as something else — or truncate the attribute and take the
  // rest of the file with it. Better to fail the build than to ship that.
  assert.throws(() => encodeWorldMapXml(doc), /does not decode/);
});

test('a mismatch between the xml and the bin is caught rather than shipped', () => {
  const real = {
    width: 8, height: 8, originX: 0, originY: 0,
    cells: [{ x: 2, y: 2, features: [
      { type: 'Polygon', rings: [[0, 0, 8, 0, 8, 8, 0, 8]], properties: [['building', 'yes']] },
    ] }],
  };
  const bin = encodeWorldMapBin(real);
  // The exact failure that shipped: a real binary with a stub beside it.
  const stub = '<?xml version="1.0" encoding="UTF-8"?>\r\n<world version="1.0">\r\n</world>\r\n';
  assert.throws(
    () => assertXmlMatchesBin(stub, bin, { width: 8, height: 8 }),
    /does not compile to the bytes/,
  );
});

/**
 * The helper's own compiler, run over an authored map.
 *
 * The two blank-map reports both came down to this one interaction, and neither
 * unit test above would have caught it, because the damage happens in another
 * package: `helper/serve.js` watches `worldmap.xml` and rebuilds
 * `worldmap.xml.bin` from it whenever it changes. So this imports the real
 * function and runs it against a real pair of files. If the authored build ever
 * writes an XML that does not compile back to its own binary, this fails here
 * rather than in front of a player with a blank map.
 */
test('the helper recompiling an authored map reproduces it byte for byte', async () => {
  const { compileMapIfChanged } = await import('../helper/serve.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pzworld-helper-'));
  try {
    const mapDir = path.join(root, 'mods', 'pzworld', 'common/media/maps/PZWorld');
    fs.mkdirSync(mapDir, { recursive: true });

    const doc = {
      width: 80, height: 80, originX: 0, originY: 0,
      cells: [
        { x: 31, y: 44, features: [
          { type: 'Polygon', rings: [[3, 3, 19, 3, 19, 15, 3, 15]], properties: [['building', 'Residential']] },
          { type: 'Polygon', rings: [[0, 60, 255, 60, 255, 68, 0, 68]], properties: [['highway', 'primary']] },
        ] },
        { x: 44, y: 31, features: [
          { type: 'Polygon', rings: [[8, 8, 200, 12, 180, 240, 4, 200]], properties: [['natural', 'forest']] },
        ] },
      ],
    };
    const bin = encodeWorldMapBin(doc);
    fs.writeFileSync(path.join(mapDir, 'worldmap.xml'), encodeWorldMapXml(doc), 'utf8');
    fs.writeFileSync(path.join(mapDir, 'worldmap.xml.bin'), bin);

    // A fresh state is what the helper has when it starts beside a world built
    // while it was not running — the case that overwrote a finished city.
    const compiled = compileMapIfChanged({ mapStamp: null }, { userFolder: root });
    assert.equal(compiled, true, 'the helper did not compile the map at all');
    assert.deepEqual(
      fs.readFileSync(path.join(mapDir, 'worldmap.xml.bin')),
      bin,
      'the helper rewrote the map into something else',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
