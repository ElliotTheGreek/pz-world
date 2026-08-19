#!/usr/bin/env node
/**
 * Capture paired visual baselines from the current road renderer and Build 42.
 *
 * The output is intentionally SVG: it is diffable, needs no image dependency,
 * and preserves one Project Zomboid square as one crisp raster unit. Run:
 *
 *   node tools/capture-visual-baselines.mjs
 *
 * Outputs go to docs/visual-baselines/ with a machine-readable manifest.
 */
import fs from 'node:fs';
import path from 'node:path';

import { normalise } from '../src/sources/osm.js';
import { Projection } from '../src/geo/project.js';
import { dominantBearing } from '../src/geo/orient.js';
import { TileCanvas } from '../src/plan/grid.js';
import { classifyRoad, loadRoadProfile, paintRoad } from '../src/plan/roads.js';
import { readLotHeader, CELL_SIZE } from '../src/formats/lotheader.js';
import { readLotPack, Cell } from '../src/formats/lotpack.js';
import { findInstall } from '../src/lib/pzinstall.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs/visual-baselines');
const SIZE = 96;
const SCALE = 4;
const CATEGORIES = [
  'urban', 'suburban', 'rural', 'highway', 'bridge', 't-junction',
  'four-way-junction', 'curved-road', 'degraded-road',
];

const COLOURS = {
  background: '#547946', natural: '#6f914f', road: '#4d4f50',
  sidewalk: '#a9a49a', curb: '#d3cfc5', marking: '#e8d55f',
  building: '#8b5945', roof: '#6d3f36', vegetation: '#315d36',
  water: '#4c82a5', degraded: '#806a4d', other: '#77776d',
};

function esc(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

function svgDocument(title, subtitle, pixels, overlays = []) {
  const width = SIZE * SCALE;
  const body = [];
  body.push(`<rect width="${width}" height="${width}" fill="${COLOURS.background}"/>`);
  for (const p of pixels) {
    body.push(`<rect x="${p.x * SCALE}" y="${p.y * SCALE}" width="${SCALE}" height="${SCALE}" fill="${p.colour}"/>`);
  }
  body.push(...overlays);
  body.push(`<rect x="0.5" y="0.5" width="${width - 1}" height="${width - 1}" fill="none" stroke="#171915"/>`);
  body.push(`<rect x="0" y="${width - 34}" width="${width}" height="34" fill="#111" opacity="0.82"/>`);
  body.push(`<text x="8" y="${width - 18}" fill="white" font-family="sans-serif" font-size="13" font-weight="bold">${esc(title)}</text>`);
  body.push(`<text x="8" y="${width - 5}" fill="#ddd" font-family="sans-serif" font-size="9">${esc(subtitle)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" viewBox="0 0 ${width} ${width}">${body.join('')}</svg>\n`;
}

function writeSvg(name, title, subtitle, pixels, overlays) {
  const file = `${name}.svg`;
  fs.writeFileSync(path.join(OUT, file), svgDocument(title, subtitle, pixels, overlays));
  return file;
}

function loadReferenceOverpass() {
  const files = fs.readdirSync(path.join(ROOT, 'cache')).filter((f) => /^overpass-.*\.json$/.test(f));
  let best = null;
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', file), 'utf8'));
    const elements = raw.elements ?? [];
    const roads = elements.filter((e) => e.tags?.highway).length;
    const buildings = elements.filter((e) => e.tags?.building).length;
    const bridges = elements.filter((e) => e.tags?.bridge && e.tags?.highway).length;
    const score = roads + buildings / 10 + bridges * 1000;
    if (!best || score > best.score) best = { file, raw, score, roads, buildings, bridges };
  }
  if (!best) throw new Error('no cached Overpass response found');
  return best;
}

function buildGenerated(reference) {
  const features = normalise(reference.raw);
  const all = [...features.roads.flatMap((r) => r.points), ...features.buildings.flatMap((b) => b.points)];
  const lat = all.reduce((n, p) => n + p[1], 0) / all.length;
  const lon = all.reduce((n, p) => n + p[0], 0) / all.length;
  const flat = new Projection({ lat, lon, metresPerTile: 1, bearing: 0 });
  const bearingInput = features.roads.map((r) => ({ points: r.points.map(([x, y]) => flat.toLocalMetres(x, y)) }));
  const bearing = dominantBearing(bearingInput);
  const proj = new Projection({ lat, lon, metresPerTile: 1, bearing, originTileX: 10000, originTileY: 10000 });
  const roads = features.roads.map((r) => ({ ...r, points: r.points.map(([x, y]) => proj.toTile(x, y)) }));
  const buildings = features.buildings.map((b) => ({ ...b, points: b.points.map(([x, y]) => proj.toTile(x, y)) }));
  const ground = features.ground.map((g) => ({ ...g, points: g.points.map(([x, y]) => proj.toTile(x, y)) }));
  const canvas = new TileCanvas();
  const profile = loadRoadProfile();
  for (const road of roads) {
    const spec = classifyRoad(road, profile);
    if (spec) paintRoad(canvas, road, spec, { builtUp: () => true }, profile);
  }
  return { features, roads, buildings, ground, canvas, bearing, proj };
}

function pointKey(p) { return `${Math.round(p[0] * 2) / 2},${Math.round(p[1] * 2) / 2}`; }

function topologyAnchors(roads) {
  const nodes = new Map();
  for (const road of roads) {
    for (let i = 0; i < road.points.length; i++) {
      const p = road.points[i];
      const key = pointKey(p);
      let n = nodes.get(key);
      if (!n) nodes.set(key, (n = { point: p, neighbours: new Set(), roads: new Set() }));
      n.roads.add(road);
      if (i > 0) n.neighbours.add(pointKey(road.points[i - 1]));
      if (i + 1 < road.points.length) n.neighbours.add(pointKey(road.points[i + 1]));
    }
  }
  return [...nodes.values()];
}

function roadMidpoint(road) { return road.points[Math.floor(road.points.length / 2)]; }
function buildingDensity(point, buildings, radius = 90) {
  const r2 = radius * radius;
  let n = 0;
  for (const b of buildings) {
    const p = b.points[0];
    if ((p[0] - point[0]) ** 2 + (p[1] - point[1]) ** 2 <= r2) n++;
  }
  return n;
}
function curveScore(road) {
  let score = 0;
  for (let i = 2; i < road.points.length; i++) {
    const a = road.points[i - 2], b = road.points[i - 1], c = road.points[i];
    const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    score += Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
  }
  return score;
}

function strongestBend(road) {
  let best = { point: roadMidpoint(road), radians: 0 };
  for (let i = 2; i < road.points.length; i++) {
    const a = road.points[i - 2], b = road.points[i - 1], c = road.points[i];
    const h1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const h2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
    const radians = Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
    if (radians > best.radians) best = { point: b, radians };
  }
  return best;
}

function pickGeneratedAnchors(g) {
  const drawable = g.roads.filter((r) => classifyRoad(r));
  const rankedDensity = drawable.map((road) => ({ road, point: roadMidpoint(road), density: buildingDensity(roadMidpoint(road), g.buildings) }));
  rankedDensity.sort((a, b) => b.density - a.density);
  const nodes = topologyAnchors(drawable);
  const exact = (degree) => nodes.filter((n) => n.neighbours.size === degree).sort((a, b) => buildingDensity(b.point, g.buildings) - buildingDensity(a.point, g.buildings))[0];
  const bridgeRoads = drawable.filter((r) => r.tags.bridge && r.tags.bridge !== 'no');
  const bridge = bridgeRoads.find((r) => !['footway', 'path', 'cycleway', 'steps'].includes(r.highway)) ?? bridgeRoads[0];
  const highway = drawable.slice().sort((a, b) => (classifyRoad(b)?.width ?? 0) - (classifyRoad(a)?.width ?? 0))[0];
  const vehicleRoads = drawable.filter((r) => !['footway', 'path', 'cycleway', 'steps'].includes(r.highway));
  const curved = vehicleRoads.slice().sort((a, b) => curveScore(b) - curveScore(a))[0];
  const bend = strongestBend(curved);
  const degraded = vehicleRoads.find((r) => /^(gravel|dirt|ground|unpaved|compacted)$/.test(r.tags.surface ?? ''))
    ?? vehicleRoads.find((r) => ['track', 'service'].includes(r.highway));
  const ruralCandidates = rankedDensity.filter(({ road }) =>
    !['motorway', 'motorway_link', 'trunk', 'trunk_link', 'footway', 'path', 'cycleway', 'steps'].includes(road.highway));
  const rural = (ruralCandidates.length ? ruralCandidates : rankedDensity).slice().sort((a, b) => a.density - b.density)[0];
  const suburban = rankedDensity[Math.floor(rankedDensity.length * 0.45)];
  return {
    urban: rankedDensity[0], suburban, rural,
    highway: { road: highway, point: roadMidpoint(highway), density: buildingDensity(roadMidpoint(highway), g.buildings) },
    bridge: { road: bridge, point: roadMidpoint(bridge), density: buildingDensity(roadMidpoint(bridge), g.buildings) },
    't-junction': { road: [...exact(3).roads][0], point: exact(3).point, density: buildingDensity(exact(3).point, g.buildings), branches: 3 },
    'four-way-junction': { road: [...exact(4).roads][0], point: exact(4).point, density: buildingDensity(exact(4).point, g.buildings), branches: 4 },
    'curved-road': { road: curved, point: bend.point, density: buildingDensity(bend.point, g.buildings), curveRadians: bend.radians },
    'degraded-road': { road: degraded, point: roadMidpoint(degraded), density: buildingDensity(roadMidpoint(degraded), g.buildings) },
  };
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function generatedCapture(g, category, anchor) {
  if (!anchor?.point) throw new Error(`no generated anchor for ${category}`);
  const minX = Math.round(anchor.point[0] - SIZE / 2), minY = Math.round(anchor.point[1] - SIZE / 2);
  const pixels = [];
  const assets = new Set();
  let roadSquares = 0, curbSquares = 0, sidewalkSquares = 0, buildingSquares = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const wx = minX + x, wy = minY + y;
    let colour = COLOURS.background;
    for (const area of g.ground) {
      if (!pointInPolygon(wx, wy, area.points)) continue;
      if (area.tags.natural === 'water' || area.tags.waterway) colour = COLOURS.water;
      else colour = COLOURS.natural;
    }
    for (const b of g.buildings) if (pointInPolygon(wx, wy, b.points)) { colour = COLOURS.building; buildingSquares++; break; }
    const sq = g.canvas.get(wx, wy);
    if (sq) {
      for (const tile of Object.values(sq)) assets.add(tile);
      const names = Object.values(sq).join(' ');
      if (/trafficlines/.test(names)) colour = COLOURS.marking;
      else if (/curbs/.test(names)) { colour = COLOURS.curb; curbSquares++; }
      else if (/exterior_tilesandstone/.test(names)) { colour = COLOURS.sidewalk; sidewalkSquares++; }
      else { colour = category === 'degraded-road' ? COLOURS.degraded : COLOURS.road; roadSquares++; }
    }
    pixels.push({ x, y, colour });
  }
  const spec = classifyRoad(anchor.road);
  const source = `${anchor.road.name ?? 'unnamed'}; highway=${anchor.road.highway}; OSM ${anchor.road.tags.bridge ? 'bridge' : 'way'}`;
  return {
    file: writeSvg(`generated-${category}`, `Generated · ${category}`, source, pixels),
    source: { cache: g.referenceFile, osmWay: anchor.road.fid, name: anchor.road.name, tags: anchor.road.tags },
    crop: { minX, minY, width: SIZE, height: SIZE },
    metrics: {
      roadClass: spec.cls,
      nominalWidth: spec.width,
      nearbyBuildings: anchor.density,
      roadSquares,
      curbSquares,
      sidewalkSquares,
      buildingSquares,
      uniqueRoadTiles: assets.size,
      branches: anchor.branches ?? null,
      curveRadians: anchor.curveRadians ?? curveScore(anchor.road),
      isBridge: Boolean(anchor.road.tags.bridge && anchor.road.tags.bridge !== 'no'),
      isDegradedSurface: /^(gravel|dirt|ground|unpaved|compacted)$/.test(anchor.road.tags.surface ?? ''),
      tiles: [...assets].sort(),
    },
  };
}

function tileKind(names) {
  const all = names.join(' ');
  if (/street_trafficlines/.test(all)) return 'marking';
  if (/street_curbs/.test(all)) return 'curb';
  if (/blends_street|floors_exterior_street|street_/.test(all)) return 'road';
  if (/damaged|crack|trash|grime|blends_natural_01_6[4-9]/.test(all)) return 'degraded';
  if (/walls_|roofs_|doors_|windows_/.test(all)) return 'building';
  if (/vegetation|tree|bush|grass/.test(all)) return 'vegetation';
  if (/water/.test(all)) return 'water';
  if (/blends_natural|natural_/.test(all)) return 'natural';
  return names.length ? 'other' : 'background';
}

function readVanillaCell(dir, cx, cy) {
  const headerFile = path.join(dir, `${cx}_${cy}.lotheader`);
  const packFile = path.join(dir, `world_${cx}_${cy}.lotpack`);
  if (!fs.existsSync(headerFile) || !fs.existsSync(packFile)) return null;
  const header = readLotHeader(fs.readFileSync(headerFile));
  const pack = readLotPack(fs.readFileSync(packFile), { levels: header.maxLevel - header.minLevel + 1 });
  return new Cell(header, pack);
}

function summarizeCell(cell) {
  const kinds = new Uint8Array(CELL_SIZE * CELL_SIZE);
  const assets = new Array(CELL_SIZE * CELL_SIZE);
  const kindId = new Map(['background','natural','road','curb','marking','building','vegetation','water','degraded','other'].map((k, i) => [k, i]));
  for (let y = 0; y < CELL_SIZE; y++) for (let x = 0; x < CELL_SIZE; x++) {
    const sq = cell.square(x, y, 0);
    const names = sq ? sq.tiles.map((i) => cell.header.tiles[i]).filter(Boolean) : [];
    assets[y * CELL_SIZE + x] = names;
    kinds[y * CELL_SIZE + x] = kindId.get(tileKind(names));
  }
  return { kinds, assets, kindId };
}

function windowMetrics(summary, x0, y0) {
  const counts = Object.fromEntries([...summary.kindId].map(([k]) => [k, 0]));
  const tiles = new Set();
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const sx = x0 + x, sy = y0 + y;
    if (sx < 0 || sy < 0 || sx >= CELL_SIZE || sy >= CELL_SIZE) continue;
    const i = sy * CELL_SIZE + sx;
    const kind = [...summary.kindId].find(([, id]) => id === summary.kinds[i])[0];
    counts[kind]++;
    for (const t of summary.assets[i]) tiles.add(t);
  }
  return { counts, tiles };
}

function branchCount(summary, cx, cy) {
  const isRoad = (x, y) => {
    if (x < 0 || y < 0 || x >= CELL_SIZE || y >= CELL_SIZE) return false;
    const id = summary.kinds[y * CELL_SIZE + x];
    return ['road','curb','marking','degraded'].some((k) => summary.kindId.get(k) === id);
  };
  const arms = [[1,0],[-1,0],[0,1],[0,-1]];
  return arms.filter(([dx, dy]) => {
    let hit = 0;
    for (let r = 12; r <= 30; r++) for (let o = -4; o <= 4; o++) if (isRoad(cx + dx * r + dy * o, cy + dy * r + dx * o)) hit++;
    return hit >= 8;
  }).length;
}

function vanillaCandidates(dir) {
  const headers = fs.readdirSync(dir).filter((f) => /^\d+_\d+\.lotheader$/.test(f));
  const scored = [];
  for (const file of headers) {
    const header = readLotHeader(fs.readFileSync(path.join(dir, file)));
    const names = header.tiles.filter(Boolean);
    const road = names.filter((n) => /blends_street|street_curbs|street_trafficlines/.test(n)).length;
    const degraded = names.filter((n) => /damaged|crack|trash|grime|blends_natural_01_6[4-9]/.test(n)).length;
    const bridge = names.filter((n) => /bridge|railings|guardrail/.test(n)).length;
    if (road) {
      const [cx, cy] = file.replace('.lotheader', '').split('_').map(Number);
      scored.push({ cx, cy, road, degraded, bridge, tileVariety: new Set(names).size });
    }
  }
  return scored.sort((a, b) => b.road - a.road || b.tileVariety - a.tileVariety);
}

function chooseVanillaSamples(dir) {
  const candidates = vanillaCandidates(dir);
  const pool = candidates.slice(0, 80);
  for (const c of candidates.filter((c) => c.bridge || c.degraded).slice(0, 30)) if (!pool.includes(c)) pool.push(c);
  const windows = [];
  for (const c of pool) {
    const cell = readVanillaCell(dir, c.cx, c.cy);
    if (!cell) continue;
    const summary = summarizeCell(cell);
    for (let y = 0; y <= CELL_SIZE - SIZE; y += 32) for (let x = 0; x <= CELL_SIZE - SIZE; x += 32) {
      const m = windowMetrics(summary, x, y);
      if (m.counts.road + m.counts.curb + m.counts.marking < 80) continue;
      const centerX = x + SIZE / 2, centerY = y + SIZE / 2;
      windows.push({ ...c, cell, summary, x, y, ...m, branches: branchCount(summary, centerX, centerY) });
    }
  }
  const take = (score, filter = () => true) => windows.filter(filter).sort((a, b) => score(b) - score(a))[0];
  const roadArea = (w) => w.counts.road + w.counts.curb + w.counts.marking;
  const built = (w) => w.counts.building;
  const entropy = (w) => w.tiles.size;
  const chosen = {
    urban: take((w) => built(w) * 3 + roadArea(w) + entropy(w)),
    suburban: take((w) => built(w) + roadArea(w), (w) => built(w) > 30 && built(w) < 700),
    rural: take((w) => w.counts.natural + w.counts.vegetation - built(w), (w) => built(w) < 100),
    highway: take((w) => w.counts.marking * 8 + roadArea(w)),
    bridge: take((w) => w.bridge * 100 + roadArea(w), (w) => w.bridge > 0),
    't-junction': take((w) => roadArea(w), (w) => w.branches === 3),
    'four-way-junction': take((w) => roadArea(w), (w) => w.branches === 4),
    'curved-road': take((w) => w.counts.curb * 4 + entropy(w), (w) => w.branches <= 2),
    'degraded-road': take((w) => w.counts.degraded * 20 + entropy(w), (w) => w.counts.degraded > 0 || w.degraded > 0),
  };
  for (const category of CATEGORIES) if (!chosen[category]) chosen[category] = take((w) => roadArea(w) + entropy(w));
  return chosen;
}

function vanillaCapture(category, w) {
  const pixels = [];
  const counts = Object.fromEntries([...w.summary.kindId].map(([k]) => [k, 0]));
  const tiles = new Set();
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const sx = w.x + x, sy = w.y + y, i = sy * CELL_SIZE + sx;
    const id = w.summary.kinds[i];
    const kind = [...w.summary.kindId].find(([, n]) => n === id)[0];
    counts[kind]++;
    for (const t of w.summary.assets[i]) tiles.add(t);
    pixels.push({ x, y, colour: COLOURS[kind] ?? COLOURS.other });
  }
  return {
    file: writeSvg(`vanilla-${category}`, `Vanilla Build 42 · ${category}`, `Muldraugh, KY cell ${w.cx}_${w.cy}; crop ${w.x},${w.y} ${SIZE}×${SIZE}`, pixels),
    source: { map: 'Muldraugh, KY', cell: `${w.cx}_${w.cy}`, installedData: true },
    crop: { x: w.x, y: w.y, width: SIZE, height: SIZE },
    metrics: { ...counts, branches: w.branches, uniqueTiles: tiles.size, tiles: [...tiles].sort() },
  };
}

function writeContactSheet(manifest, side) {
  const gap = 12, label = 24, tile = SIZE * SCALE;
  const width = tile * 3 + gap * 4, height = (tile + label) * 3 + gap * 4;
  const uses = [];
  CATEGORIES.forEach((category, i) => {
    const x = gap + (i % 3) * (tile + gap), y = gap + Math.floor(i / 3) * (tile + label + gap);
    uses.push(`<image href="${side}-${category}.svg" x="${x}" y="${y}" width="${tile}" height="${tile}"/>`);
    uses.push(`<text x="${x}" y="${y + tile + 17}" fill="#eee" font-family="sans-serif" font-size="13">${esc(category)}</text>`);
  });
  fs.writeFileSync(path.join(OUT, `${side}-contact-sheet.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#222"/>${uses.join('')}</svg>\n`);
  manifest.contactSheets[side] = `${side}-contact-sheet.svg`;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const reference = loadReferenceOverpass();
  const generated = buildGenerated(reference);
  generated.referenceFile = `cache/${reference.file}`;
  const anchors = pickGeneratedAnchors(generated);
  const install = findInstall();
  const vanillaDir = path.join(install, 'media/maps/Muldraugh, KY');
  const vanilla = chooseVanillaSamples(vanillaDir);

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    build: '42',
    sampleSizeSquares: SIZE,
    scalePixelsPerSquare: SCALE,
    legend: COLOURS,
    contactSheets: {},
    references: {
      generated: { overpassCache: generated.referenceFile, roads: reference.roads, buildings: reference.buildings, bridges: reference.bridges, bearing: generated.bearing },
      vanilla: { map: 'Muldraugh, KY', installRelativePath: 'media/maps/Muldraugh, KY' },
    },
    samples: {},
  };
  for (const category of CATEGORIES) {
    manifest.samples[category] = {
      generated: generatedCapture(generated, category, anchors[category]),
      vanilla: vanillaCapture(category, vanilla[category]),
    };
  }
  writeContactSheet(manifest, 'generated');
  writeContactSheet(manifest, 'vanilla');
  fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`captured ${CATEGORIES.length * 2} samples in ${path.relative(ROOT, OUT)}`);
  for (const category of CATEGORIES) {
    const g = manifest.samples[category].generated.metrics;
    const v = manifest.samples[category].vanilla.metrics;
    console.log(`  ${category}: generated ${g.uniqueRoadTiles} road assets; vanilla ${v.uniqueTiles} total assets, cell ${manifest.samples[category].vanilla.source.cell}`);
  }
}

main();
