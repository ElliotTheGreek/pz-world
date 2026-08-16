import fs from 'node:fs';
import path from 'node:path';
import { createGroups } from './mapgroups.js';
import { findInstall, findUserFolder } from '../src/lib/pzinstall.js';

const install = findInstall();
const user = findUserFolder();
const gameVersion = '42.20.2';
const roots = [path.join(user, 'mods')];
const ws = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/108600';
for (const item of fs.readdirSync(ws)) {
  const m = path.join(ws, item, 'mods');
  if (fs.existsSync(m)) roots.push(m);
}
const modDirs = [];
for (const r of roots) {
  for (const d of fs.readdirSync(r)) {
    const p = path.join(r, d);
    try { if (fs.statSync(p).isDirectory()) modDirs.push(p); } catch {}
  }
}
console.log(`mod folders scanned: ${modDirs.length}`);
const { groups, realDirectories } = createGroups({ install, modDirs, gameVersion });
console.log(`map dirs registered: ${realDirectories.length}`);
for (const d of realDirectories) console.log(`  ${d.name.padEnd(28)} lots=[${d.lotDirs.join(', ')}]`);
console.log(`\nGROUPS: ${groups.length}`);
groups.forEach((g,i)=>console.log(`  group ${i} (${g.length}): ${g.map(d=>d.name).slice(0,8).join(', ')}${g.length>8?' ...':''}`));
console.log(`\nhasChoices -> ${groups.length>1}`);
