#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { findUserFolder } from '../src/lib/pzinstall.js';

const root = findUserFolder();
const pattern = /mod|preset|option|save|active/i;
const maxDepth = 4;
const results = [];
function walk(dir, depth) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/^(Saves|mods|Workshop)$/i.test(entry.name) || depth > 0) walk(full, depth + 1);
      continue;
    }
    if (!pattern.test(entry.name) || !/\.(txt|ini|json|lua)$/i.test(entry.name)) continue;
    const stat = fs.statSync(full);
    results.push({ path: path.relative(root, full), size: stat.size, mtime: stat.mtime.toISOString() });
  }
}
walk(root, 0);
results.sort((a, b) => b.mtime.localeCompare(a.mtime));
console.log(JSON.stringify(results.slice(0, 300), null, 2));
