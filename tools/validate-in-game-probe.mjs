#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
  validateInGameProbe,
  validateRuntimeObservations,
} from '../src/audit/in-game-probe.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--'));
const observationsIndex = args.indexOf('--observations');
const observationsFile = observationsIndex >= 0 ? args[observationsIndex + 1] : null;
if (!file || !observationsFile) {
  console.error('usage: npm run validate-in-game-probe -- <console.txt> --observations <runtime-observations.json>');
  process.exit(2);
}
const input = path.resolve(file);
const observationsInput = path.resolve(observationsFile);
for (const [label, candidate] of [['probe console', input], ['runtime observations', observationsInput]]) {
  if (!fs.existsSync(candidate)) {
    console.error(`${label} does not exist: ${candidate}`);
    process.exit(2);
  }
}
const result = validateInGameProbe(fs.readFileSync(input, 'utf8'));
const observations = JSON.parse(fs.readFileSync(observationsInput, 'utf8'));
const observationResult = validateRuntimeObservations(observations);
result.problems.push(...observationResult.problems);
result.valid = result.problems.length === 0;
const evidence = {
  schemaVersion: 1,
  validatedAt: new Date().toISOString(),
  source: { console: path.basename(input), observations: path.basename(observationsInput) },
  valid: result.valid,
  problems: result.problems,
  begin: result.begin,
  complete: result.complete,
  observations,
};
const out = path.join(ROOT, 'library', 'in-game-probe-validation.json');
fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
if (!result.valid) {
  console.error('in-game probe validation failed:');
  for (const problem of result.problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(
  `in-game probe passed: ${result.complete.elapsedMs} ms, ` +
  `${result.complete.chunkTransitions} chunk transitions, ` +
  `${result.complete.cellTransitions} cell transitions, ` +
  `${result.complete.stalls} sampled stalls`,
);
console.log(`wrote ${path.relative(ROOT, out)}`);
