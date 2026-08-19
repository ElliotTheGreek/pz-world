import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseInGameProbe,
  validateInGameProbe,
  validateRuntimeObservations,
} from '../src/audit/in-game-probe.js';

const valid = [
  '[19-08-26 12:00:00.000] LOG  : General , PZWORLD_VALIDATION begin x=120.0 y=330.0 z=0.0',
  'PZWORLD_VALIDATION cellTransition 0,1 -> 1,1',
  'PZWORLD_VALIDATION complete reason=five-minutes elapsedMs=300012 samples=300 missingSquares=0 chunkTransitions=24 cellTransitions=3 stalls=1 maxGapMs=1040',
].join('\n');

test('parses bounded probe records out of timestamped console lines', () => {
  const parsed = parseInGameProbe(valid);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.records[0], { type: 'begin', x: 120, y: 330, z: 0 });
  assert.equal(parsed.records[1].reason, 'five-minutes');
  assert.equal(parsed.records[1].chunkTransitions, 24);
});

test('accepts a five-minute run that crosses enough chunks and cells', () => {
  const result = validateInGameProbe(valid);
  assert.equal(result.valid, true, result.problems.join('\n'));
});

test('rejects missing squares, short traversal, early exit, and probe errors', () => {
  const text = [
    'PZWORLD_VALIDATION begin x=1 y=2 z=0',
    'PZWORLD_VALIDATION error attempted to index nil',
    'PZWORLD_VALIDATION complete reason=probe-error elapsedMs=12000 samples=12 missingSquares=2 chunkTransitions=1 cellTransitions=0 stalls=0 maxGapMs=1000',
  ].join('\n');
  const result = validateInGameProbe(text);
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.includes('probe error')));
  assert.ok(result.problems.some((problem) => problem.includes('missingSquares')));
  assert.ok(result.problems.some((problem) => problem.includes('chunkTransitions')));
  assert.ok(result.problems.some((problem) => problem.includes('cellTransitions')));
});

test('accepts only complete Build 42 visual and collision observations', () => {
  const checks = Object.fromEntries([
    'urbanJunction', 'diagonalCurb', 'highwayRamp', 'ruralRoad',
    'bridgeApproach', 'parkingAndEntrance', 'nativeStability',
  ].map((key) => [key, { passed: true, notes: `${key} inspected in game` }]));
  const result = validateRuntimeObservations({
    gameVersion: '42.20.3',
    runAt: '2026-08-19T04:00:00Z',
    route: 'urban centre to bridge across two cells',
    observer: 'tester',
    checks,
  });
  assert.equal(result.valid, true, result.problems.join('\n'));
});

test('rejects an incomplete, non-Build-42, or undated observation record', () => {
  const result = validateRuntimeObservations({
    gameVersion: '41.78',
    runAt: 'not-a-date',
    route: '',
    observer: '',
    checks: { urbanJunction: { passed: false, notes: '' } },
  });
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.includes('Build 42')));
  assert.ok(result.problems.some((problem) => problem.includes('ISO-8601')));
  assert.ok(result.problems.some((problem) => problem.includes('bridgeApproach')));
});
