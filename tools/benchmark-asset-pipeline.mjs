#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { auditFixtures, assertFixtureAudit } from '../src/audit/real-world-fixtures.js';
import { loadSemanticRegistry, validateSemanticRegistry } from '../src/catalogue/semantic-registry.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'real-world');
const BASELINE = path.join(FIXTURES, 'coverage-baseline.json');
const INVENTORY = path.join(ROOT, 'library', 'asset-inventory.json');
const MAP_DIR = path.join(ROOT, 'mod', 'common', 'media', 'maps', 'PZWorld');
const JSON_REPORT = path.join(ROOT, 'library', 'asset-pipeline-benchmark.json');
const RUNTIME_REPORT = path.join(ROOT, 'library', 'in-game-probe-validation.json');
const MD_REPORT = path.join(ROOT, 'docs', 'ASSET-PIPELINE-VALIDATION.md');

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function fileSummary(files) {
  const sizes = files.map((file) => fs.statSync(file).size);
  return {
    count: files.length,
    bytes: sizes.reduce((sum, size) => sum + size, 0),
    minBytes: sizes.length ? Math.min(...sizes) : 0,
    medianBytes: percentile(sizes, 0.5),
    p95Bytes: percentile(sizes, 0.95),
    maxBytes: sizes.length ? Math.max(...sizes) : 0,
  };
}

function mapFileAudit(mapDir) {
  if (!fs.existsSync(mapDir)) return { present: false, reason: 'repository map canvas is absent' };
  const names = fs.readdirSync(mapDir);
  const cells = names.filter((name) => /^(\d+)_(\d+)\.lotheader$/.test(name));
  const missing = [];
  for (const header of cells) {
    const [, x, y] = /^(\d+)_(\d+)\.lotheader$/.exec(header);
    for (const relative of [
      `world_${x}_${y}.lotpack`,
      `chunkdata_${x}_${y}.bin`,
      path.join('maps', `biomemap_${x}_${y}.png`),
    ]) {
      if (!fs.existsSync(path.join(mapDir, relative))) missing.push(`${x}_${y}: ${relative}`);
    }
  }
  const groups = {
    lotheader: cells.map((name) => path.join(mapDir, name)),
    lotpack: names.filter((name) => /^world_\d+_\d+\.lotpack$/.test(name)).map((name) => path.join(mapDir, name)),
    chunkdata: names.filter((name) => /^chunkdata_\d+_\d+\.bin$/.test(name)).map((name) => path.join(mapDir, name)),
    biomemap: fs.existsSync(path.join(mapDir, 'maps'))
      ? fs.readdirSync(path.join(mapDir, 'maps')).filter((name) => /^biomemap_\d+_\d+\.png$/.test(name)).map((name) => path.join(mapDir, 'maps', name))
      : [],
  };
  return {
    present: true,
    cells: cells.length,
    missingCompanions: missing,
    formats: Object.fromEntries(Object.entries(groups).map(([kind, files]) => [kind, fileSummary(files)])),
  };
}

function runtimeValidationStatus() {
  if (!fs.existsSync(RUNTIME_REPORT)) {
    return {
      status: 'pending-manual-run',
      accepted: false,
      requiredArtifacts: [
        'Project Zomboid Build 42 console.txt with a complete PZWORLD_VALIDATION run',
        'completed runtime-observations.json covering visual, collision, and stability checks',
      ],
      validator: 'npm run validate-in-game-probe -- <console.txt> --observations <runtime-observations.json>',
      reason: 'No validated native game-session evidence is present.',
    };
  }
  const evidence = JSON.parse(fs.readFileSync(RUNTIME_REPORT, 'utf8'));
  if (evidence.valid !== true) {
    return {
      status: 'failed-runtime-evidence',
      accepted: false,
      evidence: path.relative(ROOT, RUNTIME_REPORT),
      problems: evidence.problems ?? ['runtime evidence is not valid'],
    };
  }
  return {
    status: 'accepted',
    accepted: true,
    evidence: path.relative(ROOT, RUNTIME_REPORT),
    validatedAt: evidence.validatedAt,
    gameVersion: evidence.observations?.gameVersion,
    runAt: evidence.observations?.runAt,
    observer: evidence.observations?.observer,
    complete: evidence.complete,
  };
}

function aggregateFixtureMetrics(builds) {
  const totals = {
    sourceElements: 0,
    roads: 0,
    renderedSquares: 0,
    tilePlacements: 0,
    seamCrossings: 0,
    seamGaps: 0,
    invalidOverlaps: 0,
  };
  for (const build of builds) {
    totals.sourceElements += build.sourceElements;
    totals.roads += build.rendered.roads;
    totals.renderedSquares += build.rendered.squares;
    totals.tilePlacements += build.rendered.metrics.tilePlacements;
    totals.seamCrossings += build.seams.crossings;
    totals.seamGaps += build.seams.gaps;
    totals.invalidOverlaps += Object.values(build.invalidOverlaps).reduce((sum, count) => sum + count, 0);
  }
  return totals;
}

function renderMarkdown(report) {
  const rows = report.fixtures.builds.map((build) => {
    const m = build.rendered.metrics;
    return `| ${build.id} | ${build.sourceElements} | ${build.rendered.roads} | ${build.rendered.squares.toLocaleString()} | ${m.tilePlacements.toLocaleString()} | ${m.uniqueTiles} | ${(m.dominantTileShare * 100).toFixed(1)}% | ${(m.adjacentSameTileRate * 100).toFixed(1)}% | ${build.seams.crossings}/${build.seams.gaps} | ${Object.values(build.invalidOverlaps).reduce((a, b) => a + b, 0)} |`;
  });
  const map = report.repositoryMap;
  const runtime = report.runtimeValidation;
  const runtimeSummary = runtime.accepted
    ? `Runtime acceptance: **accepted** from \`${runtime.evidence}\` (Build ${runtime.gameVersion}, run ${runtime.runAt}, validated ${runtime.validatedAt}).`
    : `Runtime acceptance: **${runtime.status}**. ${runtime.reason ?? (runtime.problems ?? []).join('; ')}`;
  const runtimeResult = runtime.accepted ? 'Accepted' : runtime.status;
  const runtimeVersion = runtime.accepted ? `${runtime.gameVersion}; ${runtime.runAt}` : 'Pending';
  const runtimeProbe = runtime.accepted ? `Valid: ${runtime.evidence}` : 'Pending';
  const runtimeCheck = runtime.accepted ? 'Passed; see validated observation record' : 'Pending';
  return `# Asset pipeline benchmark and validation\n\nThis report is generated by \`npm run benchmark-asset-pipeline\`. Timings are wall-clock measurements on the machine identified below; topology, overlap, repetition, semantic-validation, and file-size values are deterministic for the committed inputs.\n\n## Environment and build cost\n\n- Generated: ${report.generatedAt}\n- Node: ${report.environment.node}; platform: ${report.environment.platform}/${report.environment.arch}\n- Five pinned fixture builds: **${report.fixtures.elapsedMs.toFixed(1)} ms** total (${report.fixtures.msPerBuild.toFixed(1)} ms/build).\n- Heap delta during fixture audit: **${report.fixtures.heapDeltaMiB.toFixed(1)} MiB** (diagnostic only; GC makes this non-normative).\n\n## Fixture evidence\n\n| Fixture | Source elements | Roads | Rendered squares | Tile placements | Unique tiles | Dominant tile | Equal adjacent tile | Seam crossings/gaps | Invalid overlaps |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\nAcross all fixtures: ${report.fixtures.totals.renderedSquares.toLocaleString()} rendered squares, ${report.fixtures.totals.tilePlacements.toLocaleString()} tile placements, ${report.fixtures.totals.seamCrossings} seam crossings, **${report.fixtures.totals.seamGaps} gaps**, and **${report.fixtures.totals.invalidOverlaps} invalid overlaps**. “Equal adjacent tile” is intentionally descriptive rather than a pass/fail threshold: continuous asphalt should repeat, while variant diversity is represented by unique tiles and dominant share.\n\n## Tile validity and exclusions\n\n- Semantic registry: **${report.semanticRegistry.valid ? 'valid' : 'INVALID'}**; ${report.semanticRegistry.mappings} mappings and ${report.semanticRegistry.referencedAssets} referenced assets; ${report.semanticRegistry.errors.length} errors and ${report.semanticRegistry.warnings.length} warnings.\n- Inventory support statuses: ${Object.entries(report.semanticRegistry.inventorySupportStatuses).map(([key, value]) => `\`${key}\` ${value.toLocaleString()}`).join(', ')}.\n- Invalid loose tiles are rejected by registry validation. Structural/decorative tiles marked context-required are intentionally excluded from loose placement because walls, roofs, doors, fixtures, and furniture lose adjacency, facing, room, and loot semantics outside a complete prefab. Malformed/conflicting blend ranges remain excluded for the reasons recorded in each inventory asset’s \`statusReason\`.\n\n## Cell files and streaming evidence\n\n${map.present ? `The committed repository canvas contains **${map.cells.toLocaleString()} cells** and ${map.missingCompanions.length} missing companion files.\n\n| Format | Files | Total bytes | Median | p95 | Maximum |\n|---|---:|---:|---:|---:|---:|\n${Object.entries(map.formats).map(([kind, value]) => `| ${kind} | ${value.count.toLocaleString()} | ${value.bytes.toLocaleString()} | ${value.medianBytes.toLocaleString()} | ${value.p95Bytes.toLocaleString()} | ${value.maxBytes.toLocaleString()} |`).join('\n')}` : `No repository map canvas was present: ${map.reason}.`}\n\nOffline streaming stability is supported by complete cell companion sets and ${report.fixtures.totals.seamCrossings} exercised cross-cell road crossings with zero gaps. This does **not** prove runtime stability: native chunk streaming, frame pacing, collision behavior, and memory lifetime can only be accepted from an actual game session. See the in-game probe procedure below.\n\n## In-game probe status and acceptance procedure\n\n${runtimeSummary}\n\nThe shipped \`PZWorld_ValidationProbe.lua\` records load time, player movement, loaded-square availability, chunk transitions, stalls, and Lua errors to \`console.txt\`. It is observational and does not mutate map squares. Runtime acceptance requires a new save and all of the following:\n\n1. Find \`PZWORLD_VALIDATION begin\` and \`PZWORLD_VALIDATION complete\` in \`console.txt\`.\n2. Traverse at least 20 eight-square chunk boundaries and two 256-square cell boundaries for at least five minutes.\n3. Require zero missing-player-square samples, zero probe errors, no native crash, and no sustained streaming stall visible to the player.\n4. Inspect an urban junction, diagonal curb, highway, rural road, bridge approach, parking area, and building entrance for collisions and invalid/blank tiles.\n5. Copy \`docs/runtime-observations.example.json\`, replace every pending check with dated notes, then validate both artifacts with \`npm run validate-in-game-probe -- <console.txt> --observations <runtime-observations.json>\`.\n\n### Manual runtime evidence ledger\n\n| Evidence | Required result | Current result |\n|---|---|---|\n| Overall runtime gate | Transcript and all observations accepted | ${runtimeResult} |\n| Build/version and date | Exact Build 42 version and UTC date | ${runtimeVersion} |\n| Probe transcript | \`library/in-game-probe-validation.json\` is valid | ${runtimeProbe} |\n| Urban junction and crossing | No blank tiles, bad ownership, or collision obstruction | ${runtimeCheck} |\n| Diagonal curb and sidewalk | Correct facing and traversable opening | ${runtimeCheck} |\n| Highway/ramp | Continuous surface/markings; no urban curb; stable streaming | ${runtimeCheck} |\n| Rural/unpaved road | Correct soft edge/ditch and no invented urban pavement | ${runtimeCheck} |\n| Bridge and approaches | Continuous deck/edge, no ordinary curb overlap, usable collision | ${runtimeCheck} |\n| Parking/building entrance | No vehicle/building overlap; entrance traversable | ${runtimeCheck} |\n| Native stability/frame pacing | Five minutes, no crash or sustained visible stall | ${runtimeCheck} |\n\nNo unattended command can honestly certify visual/collision behavior inside Project Zomboid. A runtime result is therefore not fabricated by this report; until this ledger is replaced with dated observations and a validated probe record, runtime streaming and collision validation remain **pending**.\n\n## Regeneration commands\n\n\`npm test\`\n\n\`npm run audit-real-world-fixtures\`\n\n\`npm run verify-semantic-registry\`\n\n\`npm run verify-inventory-assets\`\n\n\`npm run benchmark-asset-pipeline\`\n\n\`npm run validate-asset-pipeline\` (release gate; fails until Build 42 runtime evidence is accepted)\n\n\`npm run update-golden-road-surfaces\` (only after intentional visual review; then run \`npm test\`)\n\nFor a full authored world, quit the game, run \`npm run world -- --lat <lat> --lon <lon> --radius <metres> --name <name>\`, then \`npm run verify -- <installed-mod-path>\`, start a **new save**, and execute the probe procedure above.\n`;
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
const registry = loadSemanticRegistry();
const beforeHeap = process.memoryUsage().heapUsed;
const started = performance.now();
const fixtureReport = auditFixtures(FIXTURES, baseline);
const elapsedMs = performance.now() - started;
const afterHeap = process.memoryUsage().heapUsed;
assertFixtureAudit(fixtureReport);
const semantic = validateSemanticRegistry(registry, inventory);
if (!semantic.valid) throw new Error(`semantic registry invalid:\n${semantic.errors.join('\n')}`);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  fixtures: {
    elapsedMs,
    msPerBuild: elapsedMs / fixtureReport.builds.length,
    heapDeltaMiB: (afterHeap - beforeHeap) / 1024 / 1024,
    totals: aggregateFixtureMetrics(fixtureReport.builds),
    builds: fixtureReport.builds,
  },
  semanticRegistry: {
    valid: semantic.valid,
    mappings: registry.mappings.length,
    referencedAssets: semantic.referencedAssets,
    errors: semantic.errors,
    warnings: semantic.warnings,
    inventorySupportStatuses: inventory.summary.supportStatuses,
  },
  repositoryMap: mapFileAudit(MAP_DIR),
  runtimeValidation: runtimeValidationStatus(),
};

fs.writeFileSync(JSON_REPORT, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(MD_REPORT, renderMarkdown(report));
console.log(`Benchmarked ${report.fixtures.builds.length} fixture builds in ${elapsedMs.toFixed(1)} ms; ${report.fixtures.totals.invalidOverlaps} invalid overlaps, ${report.fixtures.totals.seamGaps} seam gaps.`);
console.log(`Wrote ${path.relative(ROOT, JSON_REPORT)} and ${path.relative(ROOT, MD_REPORT)}.`);
if (process.argv.includes('--require-runtime') && !report.runtimeValidation.accepted) {
  console.error(`Runtime validation is not accepted: ${report.runtimeValidation.status}`);
  console.error('Run the Build 42 probe and validate its console plus observation record first.');
  process.exitCode = 1;
}
