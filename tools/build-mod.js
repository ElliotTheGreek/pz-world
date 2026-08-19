#!/usr/bin/env node
/**
 * Assemble the mod from sources and install it.
 *
 * The layout is not free choice — it works around a bug in
 * `zombie.MapGroups.createGroups` (DEV_GUIDE.md §1.1):
 *
 *   mod/
 *     42/                       Build 42 content
 *       mod.info
 *       media/lua/...           client and shared scripts
 *     common/
 *       media/maps/PZWorld/     the map MUST live here, not in 42/
 *
 * Every Lua file is block-checked before it is copied, because a syntax error
 * makes the file silently fail to load and costs a full game restart to find.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkBlocks } from './luacheck.js';
import { findUserFolder } from '../src/lib/pzinstall.js';
import { MOD_ID, MAP_NAME } from './make-canvas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'mod-src');
const MOD = path.join(ROOT, 'mod');

function copyLua(from, to, results) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const body = fs.readFileSync(from, 'utf8');
  const check = checkBlocks(body);
  results.push({ file: path.relative(ROOT, from), ok: check.ok, reason: check.reason });
  fs.writeFileSync(to, body, 'utf8');
}

function walk(dir, fn) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

export function buildMod({ log = () => {} } = {}) {
  const luaRoot = path.join(MOD, '42/media/lua');
  const results = [];

  // Client and shared scripts. There is no server script any more: the world is
  // built by tools/build-world.js, run by the helper, so nothing needs the
  // server Lua state's `worldgen` table.
  for (const kind of ['client', 'shared']) {
    const from = path.join(SRC, kind);
    if (!fs.existsSync(from)) continue;
    walk(from, (file) => {
      if (!file.endsWith('.lua')) return;
      const rel = path.relative(from, file);
      copyLua(file, path.join(luaRoot, kind, rel), results);
    });
  }

  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    if (!r.ok) log(`  FAIL ${r.file}: ${r.reason}`);
  }
  log(`${results.length} Lua files checked, ${bad.length} bad`);
  if (bad.length) throw new Error(`${bad.length} Lua file(s) failed the block check`);

  return { checked: results.length };
}

/**
 * Copy the mod into the user's mods folder.
 *
 * The map directory is **kept**, and that is the whole subtlety here. Installing used to
 * delete the destination outright and copy the blank canvas back over it — which meant
 * that updating a line of Lua silently destroyed a 430 MB city the player had waited
 * twenty minutes for, with no warning and no way back short of rebuilding it.
 *
 * A built world lives entirely inside `common/media/maps/<MAP_NAME>` — cells, biome maps,
 * the compiled map, street names, parking zones, spawn points — and none of it comes from
 * this repo after the canvas is first laid down. So on a reinstall that directory is left
 * exactly as it is and everything else is replaced. `--fresh` puts the blank canvas back,
 * which is what you want if the canvas format itself has changed.
 */
export function install({ log = () => {}, fresh = false } = {}) {
  const dest = path.join(findUserFolder(), 'mods', MOD_ID);
  const mapRel = path.join('common', 'media', 'maps', MAP_NAME);
  const keptMap = path.join(dest, mapRel);
  const keepMap = !fresh && fs.existsSync(keptMap);

  if (keepMap) {
    // Replace everything except the map: remove the version directory and the mod
    // metadata, leave `common/media/maps` alone, then copy back over the top.
    for (const entry of fs.readdirSync(dest)) {
      if (entry === 'common') continue;
      fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
    }
    for (const entry of fs.readdirSync(path.join(MOD, 'common'), { withFileTypes: true })) {
      if (entry.name === 'media') continue;
      fs.rmSync(path.join(dest, 'common', entry.name), { recursive: true, force: true });
    }
    let added = 0;
    fs.cpSync(MOD, dest, { recursive: true, force: true, filter: (src) => {
      const rel = path.relative(MOD, src);
      // Never overwrite anything inside the existing map directory — that is a
      // built world nobody wants to lose to a Lua edit. A file the canvas has
      // and the installed map does *not* is new, though, and skipping those
      // would mean an existing install never receives a companion the canvas
      // learned to ship: the `worldmap.xml` stub both map screens look up by
      // name is exactly that, and without it the map stays blank for ever.
      if (!rel.startsWith(mapRel) || rel === mapRel) return true;
      if (fs.existsSync(path.join(dest, rel))) return false;
      if (fs.statSync(src).isFile()) added++;
      return true;
    } });
    log(
      `installed to ${dest} (kept the built world; use --fresh to reset it)` +
        (added ? `, added ${added} new map companion file(s)` : ''),
    );
  } else {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(MOD, dest, { recursive: true });
    log(`installed to ${dest}`);
  }
  return dest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = (m) => process.stdout.write(`${m}\n`);
  buildMod({ log });
  if (!process.argv.includes('--no-install')) {
    install({ log, fresh: process.argv.includes('--fresh') });
  }
}
