#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findInstall, findUserFolder, readVersion } from '../src/lib/pzinstall.js';

const phase = process.argv[2] || 'snapshot';
const outDir = path.resolve(process.argv[3] || 'evidence/runtime-failure/fresh');
const install = findInstall();
const user = findUserFolder();
const luaDir = path.join(user, 'Lua');
const savesDir = path.join(user, 'Saves');
const mapDir = path.join(user, 'mods', 'pzworld', 'common', 'media', 'maps', 'PZWorld');
const bridgeNames = [
  'pzworld_build.txt',
  'pzworld_progress.txt',
  'pzworld_settings.txt',
  'pzworld_request.txt',
  'pzworld_status.txt',
  'pzworld_data.txt',
];

fs.mkdirSync(outDir, { recursive: true });

function metadata(file, includeBody = false) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  const result = {
    path: file,
    size: stat.size,
    birthtime: stat.birthtime.toISOString(),
    mtime: stat.mtime.toISOString(),
  };
  if (includeBody && stat.isFile()) result.body = fs.readFileSync(file, 'utf8');
  return result;
}

function walkDirectories(root) {
  const rows = [];
  if (!fs.existsSync(root)) return rows;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      rows.push({ relativePath: path.relative(root, full), ...metadata(full) });
      visit(full);
    }
  };
  visit(root);
  return rows;
}

function walkFiles(root) {
  const rows = [];
  if (!fs.existsSync(root)) return rows;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else rows.push({ relativePath: path.relative(root, full), ...metadata(full) });
    }
  };
  visit(root);
  return rows;
}

let processes = '';
try {
  processes = execFileSync('tasklist.exe', ['/v'], { encoding: 'utf8' });
} catch (err) {
  processes = `${err.message}\n${err.stdout || ''}\n${err.stderr || ''}`;
}
fs.writeFileSync(path.join(outDir, `processes-${phase}.txt`), processes);

const bridge = {};
for (const name of bridgeNames) {
  const file = path.join(luaDir, name);
  bridge[name] = metadata(file, true);
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(outDir, `${phase}-${name}`));
}

const consoleFile = path.join(user, 'console.txt');
const snapshot = {
  capturedAt: new Date().toISOString(),
  phase,
  install,
  user,
  version: readVersion(install),
  console: metadata(consoleFile),
  bridge,
  saves: walkDirectories(savesDir),
  installedMapFiles: walkFiles(mapDir),
};
fs.writeFileSync(path.join(outDir, `environment-${phase}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, `saves-${phase}.json`), `${JSON.stringify(snapshot.saves, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, `installed-map-files-${phase}.json`), `${JSON.stringify(snapshot.installedMapFiles, null, 2)}\n`);
if (fs.existsSync(consoleFile)) fs.copyFileSync(consoleFile, path.join(outDir, `console-${phase}.txt`));
console.log(`captured ${phase} evidence in ${outDir}`);
