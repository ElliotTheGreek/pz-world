#!/usr/bin/env node
/**
 * An offline reimplementation of `zombie.MapGroups.createGroups`.
 *
 * The game only shows its world picker when `MapGroups.getNumberOfGroups() > 1`
 * (`WorldSelect:hasChoices`). Whether a mod's map forms its own group is
 * therefore the single fact that decides if a standalone world is possible —
 * and testing it by launching Project Zomboid costs a full restart per attempt.
 *
 * So this reproduces the decision on the filesystem instead. Every step below
 * is transcribed from the bytecode of `zombie/MapGroups.class` and
 * `zombie/gameStates/ChooseGameInfo.class`, disassembled with tools/classdump.js:
 *
 *   createGroups(mods, includeVanilla, includeChallenges):
 *     for each active mod:
 *       details = ChooseGameInfo.getAvailableModDetails(id)   // null -> skip
 *       for dir in <commonDir>/media/maps/ :  handleMapDirectory(name, path)
 *       for dir in <versionDir>/media/maps/:  handleMapDirectory(name, path)
 *     if includeVanilla:
 *       for name in getVanillaMapDirectories(): handleMapDirectory(name, media/maps/name)
 *     for each realDirectory:
 *       resolved = getDirsRecursively(dir)          // follows lots= by name
 *       group    = findGroupWithAnyOfTheseDirectories(resolved) ?? new group
 *       group += resolved
 *
 *   handleMapDirectory(name, path):
 *     lotDirs = getLotDirectories(path)             // null -> DISCARD the map
 *     realDirectories += MapDirectory(name, path, lotDirs)
 *
 *   getLotDirectories(path):
 *     if not exists(path + "/map.info") -> null
 *     every line starting "lots=" -> value, trimmed
 *
 * Run it and it prints the groups the game would build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { findInstall, findUserFolder } from '../src/lib/pzinstall.js';

/** @typedef {{name: string, path: string, lotDirs: string[]}} MapDirectory */

/** Transcribed from MapGroups.getLotDirectories. */
export function getLotDirectories(dirPath) {
  const info = path.join(dirPath, 'map.info');
  if (!fs.existsSync(info)) return null; // <- the map is discarded entirely
  const out = [];
  for (const raw of fs.readFileSync(info, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('lots=')) out.push(line.replace('lots=', '').trim());
  }
  return out;
}

/**
 * Transcribed from ChooseGameInfo.readModInfo plus Mod.isAvailableSelf.
 * A mod whose `versionMin` exceeds the game version is not "available", and an
 * unavailable mod's maps are never scanned even though its Lua still loads.
 */
export function readModInfo(modDir) {
  // The game looks for mod.info at the mod root and inside each version dir.
  const candidates = [
    { file: path.join(modDir, 'mod.info'), versionDir: modDir, common: path.join(modDir, 'common') },
  ];
  for (const entry of safeList(modDir)) {
    if (!/^\d+(\.\d+)*$/.test(entry)) continue;
    candidates.push({
      file: path.join(modDir, entry, 'mod.info'),
      versionDir: path.join(modDir, entry),
      common: path.join(modDir, 'common'),
      version: entry,
    });
  }

  const found = candidates.filter((c) => fs.existsSync(c.file));
  if (!found.length) return null;

  // Prefer the highest version directory the game version satisfies; that is
  // what getVersionDir resolves to in practice.
  const best = found[found.length - 1];
  const text = fs.readFileSync(best.file, 'utf8');
  const field = (name) => {
    const m = text.split(/\r?\n/).find((l) => l.trim().startsWith(`${name}=`));
    return m ? m.trim().slice(name.length + 1).trim() : null;
  };
  return {
    id: field('id'),
    name: field('name'),
    versionMin: field('versionMin'),
    versionMax: field('versionMax'),
    require: field('require'),
    dir: modDir,
    versionDir: best.versionDir,
    commonDir: best.common,
    infoFile: best.file,
  };
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function isAvailable(mod, gameVersion) {
  if (mod.versionMin && cmpVersion(mod.versionMin, gameVersion) > 0) return false;
  if (mod.versionMax && cmpVersion(mod.versionMax, gameVersion) < 0) return false;
  return true;
}

export function createGroups({ install, modDirs, gameVersion, includeVanilla = true, log = () => {} }) {
  /** @type {MapDirectory[]} */
  const realDirectories = [];
  const skipped = [];

  const handleMapDirectory = (name, dirPath) => {
    const lotDirs = getLotDirectories(dirPath);
    if (lotDirs === null) {
      skipped.push({ name, dirPath, reason: 'no map.info' });
      return;
    }
    realDirectories.push({ name, path: dirPath, lotDirs });
  };

  for (const modDir of modDirs) {
    const mod = readModInfo(modDir);
    if (!mod) {
      skipped.push({ name: path.basename(modDir), reason: 'no mod.info' });
      continue;
    }
    if (!isAvailable(mod, gameVersion)) {
      skipped.push({ name: mod.id, reason: `not available (versionMin ${mod.versionMin})` });
      continue;
    }
    for (const base of [mod.commonDir, mod.versionDir]) {
      const mapsRoot = path.join(base, 'media/maps');
      if (!fs.existsSync(mapsRoot)) continue;
      for (const entry of safeList(mapsRoot)) {
        if (entry.toLowerCase() === 'challengemaps') continue;
        handleMapDirectory(entry, path.join(mapsRoot, entry));
      }
      log(`  scanned ${mapsRoot}`);
    }
  }

  if (includeVanilla) {
    const vanillaRoot = path.join(install, 'media/maps');
    for (const entry of safeList(vanillaRoot)) {
      if (entry.toLowerCase() === 'challengemaps') continue;
      handleMapDirectory(entry, path.join(vanillaRoot, entry));
    }
  }

  // getDirsRecursively: follow lotDirs by directory *name*, guarding repeats.
  const dirsRecursively = (dir, acc = []) => {
    if (acc.includes(dir)) return acc;
    acc.push(dir);
    for (const want of dir.lotDirs) {
      const match = realDirectories.find((d) => d.name === want);
      if (match) dirsRecursively(match, acc);
    }
    return acc;
  };

  /** @type {MapDirectory[][]} */
  const groups = [];
  for (const dir of realDirectories) {
    const resolved = dirsRecursively(dir);
    let group = groups.find((g) => resolved.some((d) => g.includes(d)));
    if (!group) groups.push((group = []));
    for (const d of resolved) if (!group.includes(d)) group.push(d);
  }

  return { groups, realDirectories, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const install = findInstall();
  const user = findUserFolder();
  const gameVersion = fs.readFileSync(path.join(user, 'version.txt'), 'utf8').trim().split(/\s+/)[0];

  // Only the mods actually enabled matter; default.txt holds the active list.
  const modsRoot = path.join(user, 'mods');
  const only = process.argv.slice(2);
  const modDirs = safeList(modsRoot)
    .map((d) => path.join(modsRoot, d))
    .filter((d) => fs.statSync(d).isDirectory())
    .filter((d) => (only.length ? only.includes(path.basename(d)) : true));

  process.stdout.write(`game ${gameVersion}\nmods: ${modDirs.map((d) => path.basename(d)).join(', ')}\n\n`);

  const { groups, realDirectories, skipped } = createGroups({
    install,
    modDirs,
    gameVersion,
    log: (m) => process.stdout.write(`${m}\n`),
  });

  process.stdout.write(`\nmap directories registered: ${realDirectories.length}\n`);
  for (const d of realDirectories) {
    process.stdout.write(`  ${d.name.padEnd(24)} lots=[${d.lotDirs.join(', ')}]\n`);
  }
  if (skipped.length) {
    process.stdout.write(`\nskipped:\n`);
    for (const s of skipped) process.stdout.write(`  ${String(s.name).padEnd(24)} ${s.reason}\n`);
  }

  process.stdout.write(`\nGROUPS: ${groups.length}\n`);
  groups.forEach((g, i) => {
    process.stdout.write(`  group ${i}: ${g.map((d) => d.name).join(', ')}\n`);
  });
  process.stdout.write(
    `\nWorldSelect:hasChoices() -> ${groups.length > 1}  (needs > 1 group)\n`,
  );
}
