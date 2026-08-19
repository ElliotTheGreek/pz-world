#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'cache');
const OUT = path.join(ROOT, 'test', 'fixtures', 'real-world');

const SPECS = [
  { id: 'urban', required: ['building', 'residential-road', 'sidewalk'], match: (e) => e.tags?.building && e.geometry?.length >= 4 },
  { id: 'suburban', required: ['building', 'residential-road'], match: (e) => ['house', 'detached', 'residential', 'yes'].includes(e.tags?.building) },
  { id: 'rural', required: ['rural-road'], match: (e) => ['track', 'unclassified', 'tertiary'].includes(e.tags?.highway) },
  { id: 'highway', required: ['highway', 'shoulder', 'lane-marking'], match: (e) => /^(motorway|trunk)(_link)?$/.test(e.tags?.highway ?? '') },
  { id: 'bridge', required: ['bridge', 'bridge-deck', 'bridge-edge'], match: (e) => e.tags?.bridge && !['no', 'false', '0'].includes(String(e.tags.bridge)) && e.tags?.highway },
];

function points(element) {
  if (Array.isArray(element.geometry)) return element.geometry.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) return [{ lat: element.lat, lon: element.lon }];
  return [];
}

function centre(element) {
  const geometry = points(element);
  return geometry.reduce((out, p) => ({ lat: out.lat + p.lat / geometry.length, lon: out.lon + p.lon / geometry.length }), { lat: 0, lon: 0 });
}

function distanceSquared(a, b) {
  return (a.lat - b.lat) ** 2 + (a.lon - b.lon) ** 2;
}

function rank(spec, element) {
  const tags = element.tags ?? {};
  let score = points(element).length;
  if (spec.id === 'urban') score += tags.amenity || tags.shop ? 500 : 0;
  if (spec.id === 'suburban') score += tags.building === 'house' ? 500 : 0;
  if (spec.id === 'rural') score += tags.highway === 'track' ? 500 : 0;
  if (spec.id === 'highway') score += tags.highway === 'motorway' ? 1000 : 0;
  if (spec.id === 'bridge') score += tags.highway !== 'footway' ? 1000 : 0;
  return score;
}

fs.mkdirSync(OUT, { recursive: true });
const cacheFiles = fs.readdirSync(CACHE).filter((name) => /^overpass-[0-9a-f]+\.json$/.test(name)).sort();
const sources = cacheFiles.map((file) => ({ file, json: JSON.parse(fs.readFileSync(path.join(CACHE, file), 'utf8')) }));
const manifest = { schemaVersion: 1, attribution: '© OpenStreetMap contributors, ODbL 1.0', fixtures: [] };

for (const spec of SPECS) {
  const candidates = sources.flatMap((source) => (source.json.elements ?? [])
    .filter(spec.match)
    .map((element) => ({ source, element, score: rank(spec, element) })));
  candidates.sort((a, b) => b.score - a.score || a.source.file.localeCompare(b.source.file) || a.element.id - b.element.id);
  if (!candidates.length) throw new Error(`no cached real-world candidate for ${spec.id}`);
  const selected = candidates[0];
  const anchor = centre(selected.element);
  const nearby = (selected.source.json.elements ?? [])
    .filter((element) => points(element).length)
    .map((element) => ({ element, distance: distanceSquared(anchor, centre(element)) }))
    .sort((a, b) => a.distance - b.distance || a.element.id - b.element.id)
    .slice(0, 80)
    .map(({ element }) => element);
  if (!nearby.some((element) => element.type === selected.element.type && element.id === selected.element.id)) nearby.unshift(selected.element);
  const payload = {
    version: selected.source.json.version,
    generator: selected.source.json.generator,
    osm3s: selected.source.json.osm3s,
    fixture: { id: spec.id, sourceCache: selected.source.file, anchorElement: `${selected.element.type}/${selected.element.id}`, requiredFeatureClasses: spec.required },
    elements: nearby,
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const file = `${spec.id}.osm.json`;
  fs.writeFileSync(path.join(OUT, file), text);
  manifest.fixtures.push({ id: spec.id, file, sourceCache: selected.source.file, anchorElement: payload.fixture.anchorElement, requiredFeatureClasses: spec.required, elements: nearby.length, sha256: createHash('sha256').update(text).digest('hex') });
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Pinned ${manifest.fixtures.length} real-world fixtures in ${path.relative(ROOT, OUT)}`);
