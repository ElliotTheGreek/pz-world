#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { findUserFolder } from '../src/lib/pzinstall.js';
const root = findUserFolder();
function list(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const full = path.join(dir, entry.name);
    const stat = fs.statSync(full);
    return { name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size: stat.size, mtime: stat.mtime.toISOString() };
  });
}
const defaultMods = path.join(root, 'mods', 'default.txt');
console.log(JSON.stringify({
  root,
  rootEntries: list(root),
  modEntries: list(path.join(root, 'mods')),
  defaultMods: fs.existsSync(defaultMods) ? fs.readFileSync(defaultMods, 'utf8') : null,
}, null, 2));
