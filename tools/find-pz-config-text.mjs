#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { findUserFolder } from '../src/lib/pzinstall.js';

const root = findUserFolder();
const hits = [];
function walk(dir, depth = 0) {
  if (depth > 5) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      if (/^(Saves|Workshop|logs|mods)$/i.test(entry.name)) continue;
      walk(full, depth + 1);
      continue;
    }
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > 2_000_000) continue;
    let body;
    try { body = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (/pzworld|pz-world|activeMods|mods\s*=|modIDs/i.test(body)) {
      hits.push({ path: rel, size: stat.size, mtime: stat.mtime.toISOString(), matches: body.split(/\r?\n/).filter((line) => /pzworld|pz-world|activeMods|mods\s*=|modIDs/i.test(line)).slice(0, 30) });
    }
  }
}
walk(root);
console.log(JSON.stringify(hits, null, 2));
