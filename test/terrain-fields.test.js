import test from 'node:test';
import assert from 'node:assert/strict';

import { TerrainFields, TERRAIN_FIELD_SPECS, terrainFields } from '../src/plan/terrain-fields.js';

const NAMES = ['grass', 'dirt', 'vegetation', 'moisture', 'wear', 'patch'];

test('terrain fields are bounded, seeded, and deterministic', () => {
  const a = terrainFields('alpha');
  const rebuilt = terrainFields('alpha');
  const other = terrainFields('beta');
  let seedDifferences = 0;

  for (const name of NAMES) {
    assert.ok(TERRAIN_FIELD_SPECS[name], `missing specification for ${name}`);
    for (const [x, y] of [[0, 0], [17, 42], [-301, 599], [12345, -9876]]) {
      const value = a.at(name, x, y);
      assert.ok(value >= 0 && value <= 1, `${name} at ${x},${y} was ${value}`);
      assert.equal(value, rebuilt.at(name, x, y), `${name} changed after rebuilding fields`);
      if (value !== other.at(name, x, y)) seedDifferences++;
    }
  }

  assert.ok(seedDifferences >= NAMES.length, 'changing the world seed should change the fields');
});

test('terrain fields do not depend on sampling order', () => {
  const points = [];
  for (let y = 291; y <= 309; y++) {
    for (let x = -9; x <= 9; x++) points.push([x, y]);
  }

  const forwardFields = terrainFields('order');
  const forward = new Map();
  for (const [x, y] of points) {
    for (const name of NAMES) forward.set(`${name}:${x},${y}`, forwardFields.at(name, x, y));
  }

  const reverseFields = terrainFields('order');
  for (const [x, y] of [...points].reverse()) {
    for (const name of [...NAMES].reverse()) {
      assert.equal(
        reverseFields.at(name, x, y),
        forward.get(`${name}:${x},${y}`),
        `${name} depended on iteration order at ${x},${y}`,
      );
    }
  }
});

test('chunk and cell boundaries do not reset terrain fields', () => {
  const whole = terrainFields('seams');

  // Simulate independently generated regions on both sides of Build 42's 8-square chunk
  // and 256-square cell boundaries. Reconstructing the sampler must produce the same
  // edge values as sampling the entire world continuously.
  for (const boundary of [0, 8, 256, 512, -256]) {
    const leftBuild = terrainFields('seams');
    const rightBuild = terrainFields('seams');
    for (const name of NAMES) {
      for (let y = -4; y <= 4; y++) {
        assert.equal(leftBuild.at(name, boundary - 1, y), whole.at(name, boundary - 1, y));
        assert.equal(rightBuild.at(name, boundary, y), whole.at(name, boundary, y));
      }
    }
  }
});

test('named terrain concerns use independent fields with local variation', () => {
  const fields = new TerrainFields('independence');
  const samples = new Map(NAMES.map((name) => [name, []]));
  for (let y = 0; y < 128; y += 4) {
    for (let x = 0; x < 128; x += 4) {
      for (const name of NAMES) samples.get(name).push(fields.at(name, x, y));
    }
  }

  for (const name of NAMES) {
    const values = samples.get(name);
    assert.ok(Math.max(...values) - Math.min(...values) > 0.03, `${name} is effectively flat`);
  }

  for (let i = 0; i < NAMES.length; i++) {
    for (let j = i + 1; j < NAMES.length; j++) {
      assert.notDeepEqual(
        samples.get(NAMES[i]),
        samples.get(NAMES[j]),
        `${NAMES[i]} and ${NAMES[j]} should not share a field`,
      );
    }
  }
});

test('noise-compatible views preserve absolute-coordinate samples', () => {
  const fields = terrainFields('views');
  for (const name of NAMES) {
    const view = fields.view(name);
    assert.equal(view.fbm(299, 301, 1, 99), fields.at(name, 299, 301));
  }
});
