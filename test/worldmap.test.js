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
import path from 'node:path';

import {
  decodeWorldMapBin,
  encodeWorldMapBin,
  parseWorldMapXml,
  compileWorldMapXml,
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
