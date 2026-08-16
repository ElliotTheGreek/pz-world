/**
 * The biome map is the whole ground/zone channel for the worldgen route, so
 * the codec has to agree with the game's reading of it exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { encodeIndexedPng, decodePng } from '../src/formats/png.js';
import { findInstall } from '../src/lib/pzinstall.js';

let INSTALL = null;
try {
  INSTALL = findInstall();
} catch {
  /* skipped below */
}
const BIOMES = INSTALL ? path.join(INSTALL, 'media/maps/Muldraugh, KY/maps') : null;
const skip = BIOMES && fs.existsSync(BIOMES) ? false : 'Project Zomboid install not found';

test('indexed PNG round-trips every byte value', () => {
  const pixels = new Uint8Array(256 * 256);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7) & 0xff;

  const decoded = decodePng(encodeIndexedPng({ width: 256, height: 256, pixels }));
  assert.equal(decoded.width, 256);
  assert.equal(decoded.height, 256);
  assert.equal(decoded.colorType, 3);
  assert.deepEqual(Buffer.from(decoded.pixels), Buffer.from(pixels));
});

test('the greyscale ramp palette makes index and grey value identical', () => {
  const pixels = new Uint8Array(4).fill(115);
  const decoded = decodePng(encodeIndexedPng({ width: 2, height: 2, pixels }));
  const i = decoded.pixels[0];
  assert.equal(i, 115);
  // This is the property the game depends on: a vanilla biome map stores
  // rgb(115,115,115) for a TownZone square, so our palette entry for index 115
  // must be that same grey or the zone would be misread.
  assert.equal(decoded.palette[i * 3], 115);
  assert.equal(decoded.palette[i * 3 + 1], 115);
  assert.equal(decoded.palette[i * 3 + 2], 115);
});

test('vanilla biome maps decode and are 256x256 indexed', { skip }, () => {
  const files = fs.readdirSync(BIOMES).filter((f) => f.endsWith('.png'));
  assert.ok(files.length > 4000, `expected a biome map per cell, got ${files.length}`);

  // A deterministic spread rather than the whole set — decoding 4,914 PNGs is
  // not what this test is for.
  for (let i = 0; i < files.length; i += Math.floor(files.length / 40)) {
    const img = decodePng(fs.readFileSync(path.join(BIOMES, files[i])));
    assert.equal(img.width, 256, files[i]);
    assert.equal(img.height, 256, files[i]);
    assert.equal(img.colorType, 3, files[i]);
    assert.ok(img.palette, `${files[i]} has no palette`);
  }
});

test('a downtown biome map is dominated by the TownZone grey', { skip }, () => {
  // 49_6 is downtown Muldraugh. BiomeMapConfig.lua maps pixel 115 to
  // biome "townhouse", zone "TownZone".
  const img = decodePng(fs.readFileSync(path.join(BIOMES, 'biomemap_49_6.png')));
  const greys = new Map();
  for (const idx of img.pixels) {
    const grey = img.palette[idx * 3];
    greys.set(grey, (greys.get(grey) ?? 0) + 1);
  }
  const [top] = [...greys].sort((a, b) => b[1] - a[1]);
  assert.equal(top[0], 115, `dominant grey was ${top[0]}, expected 115 (TownZone)`);
});
