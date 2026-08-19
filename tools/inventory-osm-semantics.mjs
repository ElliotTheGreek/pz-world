#!/usr/bin/env node
/** Generate a complete audit of the current OSM query and cached observations. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditOsmSemantics, renderOsmSemanticsReport } from '../src/catalogue/osm-semantics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argument(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const cacheDir = path.resolve(ROOT, argument('--cache', 'cache'));
const outputFile = path.resolve(ROOT, argument('--out', 'library/osm-semantics.json'));
const reportFile = path.resolve(ROOT, argument('--report', 'docs/OSM-SEMANTICS.md'));
const files = fs.readdirSync(cacheDir)
  .filter((file) => /^overpass-[0-9a-f]+\.json$/i.test(file))
  .sort();

if (!files.length) throw new Error(`no cached Overpass responses in ${cacheDir}`);

const sources = files.map((file) => ({
  file: path.relative(ROOT, path.join(cacheDir, file)).replaceAll('\\', '/'),
  data: JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf8')),
}));
const inventory = auditOsmSemantics(sources);

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(inventory, null, 2)}\n`);
fs.writeFileSync(reportFile, renderOsmSemanticsReport(inventory));

console.log(`audited ${inventory.summary.elements.toLocaleString()} OSM elements and ${inventory.summary.tags.toLocaleString()} tag keys`);
console.log(`  ${path.relative(ROOT, outputFile)}`);
console.log(`  ${path.relative(ROOT, reportFile)}`);
console.log(`  retained=${inventory.parser.retainedElements}, discarded=${inventory.parser.discardedElements}`);
