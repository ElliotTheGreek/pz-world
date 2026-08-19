import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const report = JSON.parse(fs.readFileSync(
  new URL('../library/asset-pipeline-benchmark.json', import.meta.url),
  'utf8',
));
const validation = fs.readFileSync(
  new URL('../docs/ASSET-PIPELINE-VALIDATION.md', import.meta.url),
  'utf8',
);

test('benchmark evidence covers every pinned real-world fixture', () => {
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(
    report.fixtures.builds.map((build) => build.id),
    ['urban', 'suburban', 'rural', 'highway', 'bridge'],
  );
  assert.equal(report.fixtures.totals.sourceElements, 400);
  assert.ok(report.fixtures.totals.renderedSquares > 100000);
  assert.ok(report.fixtures.totals.tilePlacements >= report.fixtures.totals.renderedSquares);
});

test('benchmark acceptance gates reject seam and ownership collisions', () => {
  assert.equal(report.fixtures.totals.seamGaps, 0);
  assert.equal(report.fixtures.totals.invalidOverlaps, 0);
  assert.ok(report.fixtures.totals.seamCrossings >= 50);
  for (const build of report.fixtures.builds) {
    assert.equal(build.missingFeatureClasses.length, 0, build.id);
    assert.equal(build.seams.gaps, 0, build.id);
    assert.ok(build.seams.crossings > 0, build.id);
    assert.ok(build.rendered.metrics.uniqueTiles > 0, build.id);
    assert.ok(build.rendered.metrics.occupiedCells > 1, build.id);
    assert.ok(build.rendered.metrics.dominantTileShare > 0);
    assert.ok(build.rendered.metrics.dominantTileShare < 1);
    assert.equal(
      Object.values(build.invalidOverlaps).reduce((sum, count) => sum + count, 0),
      0,
      build.id,
    );
  }
});

test('cell companion audit is complete and semantic assets are valid', () => {
  assert.equal(report.semanticRegistry.valid, true);
  assert.equal(report.semanticRegistry.errors.length, 0);
  assert.equal(report.repositoryMap.present, true);
  assert.equal(report.repositoryMap.cells, 6400);
  assert.deepEqual(report.repositoryMap.missingCompanions, []);
  for (const kind of ['lotheader', 'lotpack', 'chunkdata', 'biomemap']) {
    assert.equal(report.repositoryMap.formats[kind].count, 6400, kind);
    assert.ok(report.repositoryMap.formats[kind].maxBytes > 0, kind);
  }
});

test('generated evidence never represents an absent game run as a pass', () => {
  assert.equal(report.runtimeValidation.status, 'pending-manual-run');
  assert.equal(report.runtimeValidation.accepted, false);
  assert.equal(report.runtimeValidation.requiredArtifacts.length, 2);
  assert.match(report.runtimeValidation.validator, /validate-in-game-probe/);
  assert.match(validation, /Runtime acceptance: \*\*pending-manual-run\*\*/);
  assert.match(validation, /runtime streaming and collision validation remain \*\*pending\*\*/);
  assert.match(validation, /\| Probe transcript .* \| Pending \|/);
  assert.match(validation, /npm run validate-in-game-probe/);
});
