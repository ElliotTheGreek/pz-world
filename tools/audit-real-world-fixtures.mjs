#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { assertFixtureAudit, auditFixtures } from '../src/audit/real-world-fixtures.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'real-world');
const BASELINE = path.join(FIXTURES, 'coverage-baseline.json');
const REPORT = path.join(ROOT, 'library', 'real-world-fixture-audit.json');
const update = process.argv.includes('--update-baseline');
const baseline = !update && fs.existsSync(BASELINE)
  ? JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  : null;

const report = auditFixtures(FIXTURES, baseline);
assertFixtureAudit(report);
const stable = { ...report };
delete stable.regressions;

if (update) {
  fs.writeFileSync(BASELINE, `${JSON.stringify(stable, null, 2)}\n`);
  console.log(`Updated ${path.relative(ROOT, BASELINE)}`);
}
fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `Audited ${report.builds.length} pinned builds, ${report.coveredFamilies.length} asset families, ` +
  `${report.builds.reduce((sum, build) => sum + build.seams.crossings, 0)} seam crossings; no regressions.`,
);
