#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { findInstall, findUserFolder } from '../src/lib/pzinstall.js';
import { decodeWorldMapBin } from '../src/formats/worldmap.js';
import { MOD_ID, MAP_NAME } from './make-canvas.js';

const install = findInstall();
const user = findUserFolder();
const mapDir = path.join(user, 'mods', MOD_ID, 'common', 'media', 'maps', MAP_NAME);
console.log(JSON.stringify({ install, user, mapDir }, null, 2));

for (const name of ['map.info', 'ATTRIBUTION.txt', 'worldmap.xml', 'worldmap.xml.bin', 'streets.xml']) {
  const file = path.join(mapDir, name);
  if (!fs.existsSync(file)) {
    console.log(`${name}: MISSING`);
    continue;
  }
  const stat = fs.statSync(file);
  console.log(`${name}: ${stat.size} bytes, mtime ${stat.mtime.toISOString()}`);
  if (name === 'ATTRIBUTION.txt' || name === 'map.info') {
    console.log(fs.readFileSync(file, 'utf8').trim());
  }
  if (name === 'worldmap.xml.bin') {
    try {
      const doc = decodeWorldMapBin(fs.readFileSync(file));
      const features = doc.cells.reduce((n, cell) => n + cell.features.length, 0);
      const properties = new Map();
      for (const cell of doc.cells) {
        for (const feature of cell.features) {
          for (const [key, value] of feature.properties) {
            const tag = `${key}=${value}`;
            properties.set(tag, (properties.get(tag) ?? 0) + 1);
          }
        }
      }
      console.log(`  decoded: grid ${doc.width}x${doc.height} at ${doc.originX},${doc.originY}; ${doc.cells.length} cells; ${features} features`);
      console.log(`  properties: ${JSON.stringify(Object.fromEntries([...properties].sort()))}`);
      console.log(`  cells: x ${Math.min(...doc.cells.map((c) => c.x))}..${Math.max(...doc.cells.map((c) => c.x))}, y ${Math.min(...doc.cells.map((c) => c.y))}..${Math.max(...doc.cells.map((c) => c.y))}`);
    } catch (err) {
      console.log(`  DECODE FAILED: ${err.stack}`);
    }
  }
}

const wanted = new Set(['ISWorldMap.lua', 'ISMiniMap.lua', 'MapUtils.lua', 'ISMapDefinitions.lua']);
const roots = [path.join(install, 'media', 'lua')];
for (const root of roots) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (wanted.has(entry.name)) console.log(`VANILLA ${entry.name}: ${file}`);
    }
  }
}
