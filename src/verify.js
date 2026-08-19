/**
 * Checking a generated mod without launching the game.
 *
 * A wrong prefab does not crash Project Zomboid. It renders a blank square, or
 * a wall lying flat on the ground, or nothing at all — and you find out twenty
 * minutes into a new save. So everything that *can* be checked from the files
 * is checked here, with the same readers that wrote them.
 *
 * What this cannot check is whether the game likes the result. That still needs
 * a play test, and README.md says so.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readLotHeader, CELL_SIZE } from './formats/lotheader.js';
import { readLotPack } from './formats/lotpack.js';
import { decodePng } from './formats/png.js';
import { decodeWorldMapBin } from './formats/worldmap.js';
import { loadTileCatalogue } from './formats/tiledefs.js';
import { findInstall, readMapTileNames } from './lib/pzinstall.js';

/**
 * Every grey value BiomeMapConfig.lua gives a meaning. A biome map pixel
 * outside this set is ground the game does not know how to populate.
 */
export function readBiomePixels(install) {
  const file = path.join(install, 'media/lua/server/metazones/BiomeMapConfig.lua');
  const text = fs.readFileSync(file, 'utf8');
  const pixels = new Set();
  for (const m of text.matchAll(/^\s*\{\s*pixel\s*=\s*(\d+)/gm)) pixels.add(Number(m[1]));
  return pixels;
}

/**
 * @param {string} dir  a generated mod directory
 * @returns {{problems: string[], stats: object}}
 */
export function verifyMod(dir, opts = {}) {
  const log = opts.log ?? (() => {});
  const problems = [];
  const stats = { cells: 0, prefabs: 0, tiles: 0, modules: 0 };

  const install = findInstall(opts.install);
  const cat = loadTileCatalogue(install);
  const validPixels = readBiomePixels(install);
  // Two independent registers of what a real tile is — see readMapTileNames.
  const fromMaps = readMapTileNames(install, opts.cacheDir);
  const tileExists = (name) => cat.tileExists(name) || fromMaps.has(name);

  // ---- locate the mod ---------------------------------------------------
  // Build 42 content lives in a `42/` subfolder; anything at the root is read
  // by the game as Build 41 content. Accept either so an older output can
  // still be checked, but say which one was found.
  let root = dir;
  if (fs.existsSync(path.join(dir, '42', 'mod.info'))) {
    root = path.join(dir, '42');
  } else if (fs.existsSync(path.join(dir, 'mod.info'))) {
    problems.push(
      'mod.info is at the mod root, so Build 42 will not list this mod — it belongs in 42/',
    );
  } else {
    problems.push('no mod.info found');
    return { problems, stats };
  }

  // Build 42 loads scripts and metadata from 42/, but MapGroups only discovers maps
  // under common/media/maps. Older generated mods may still keep both under one root.
  const commonMapsRoot = path.join(dir, 'common', 'media', 'maps');
  const versionMapsRoot = path.join(root, 'media', 'maps');
  const mapsRoot = fs.existsSync(commonMapsRoot) ? commonMapsRoot : versionMapsRoot;
  if (!fs.existsSync(mapsRoot)) {
    problems.push('no media/maps directory (checked common/ and the version root)');
    return { problems, stats };
  }
  const mapNames = fs.readdirSync(mapsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (!mapNames.length) {
    problems.push('media/maps contains no map directory');
    return { problems, stats };
  }
  const mapName = mapNames[0];
  const mapDir = path.join(mapsRoot, mapName);

  for (const required of ['map.info', 'spawnpoints.lua']) {
    if (!fs.existsSync(path.join(mapDir, required))) problems.push(`missing ${required}`);
  }
  const hasWorldgenOverride = fs.existsSync(path.join(mapDir, 'WorldGenOverride.lua'));

  // ---- cells ------------------------------------------------------------
  for (const f of fs.readdirSync(mapDir)) {
    const m = /^(\d+)_(\d+)\.lotheader$/.exec(f);
    if (!m) continue;
    stats.cells++;
    const cx = +m[1];
    const cy = +m[2];
    try {
      const header = readLotHeader(fs.readFileSync(path.join(mapDir, f)));
      for (const tile of header.tiles) {
        stats.tiles++;
        if (!tileExists(tile)) problems.push(`cell ${cx}_${cy}: unknown tile ${tile}`);
      }
      readLotPack(fs.readFileSync(path.join(mapDir, `world_${cx}_${cy}.lotpack`)), {
        levels: header.maxLevel - header.minLevel + 1,
        chunkSize: header.chunkW,
      });
    } catch (err) {
      problems.push(`cell ${cx}_${cy}: ${err.message}`);
    }
    const biome = path.join(mapDir, 'maps', `biomemap_${cx}_${cy}.png`);
    if (!fs.existsSync(biome)) {
      problems.push(`cell ${cx}_${cy} has no biome map`);
      continue;
    }
    try {
      const img = decodePng(fs.readFileSync(biome));
      if (img.width !== CELL_SIZE || img.height !== CELL_SIZE) {
        problems.push(`biomemap_${cx}_${cy}.png is ${img.width}×${img.height}`);
      }
      const seen = new Set();
      for (const idx of img.pixels) seen.add(img.palette ? img.palette[idx * 3] : idx);
      for (const grey of seen) {
        if (!validPixels.has(grey)) {
          problems.push(`biomemap_${cx}_${cy}.png uses grey ${grey}, which BiomeMapConfig ignores`);
          break;
        }
      }
    } catch (err) {
      problems.push(`biomemap_${cx}_${cy}.png: ${err.message}`);
    }
  }

  // ---- prefabs ----------------------------------------------------------
  const prefabDir = path.join(root, 'media/lua/server/WorldGen/prefabs');
  const known = new Set();
  if (fs.existsSync(prefabDir)) {
    for (const f of fs.readdirSync(prefabDir)) {
      if (!f.endsWith('.lua')) continue;
      stats.prefabs++;
      known.add(f.replace(/\.lua$/, ''));
      const text = fs.readFileSync(path.join(prefabDir, f), 'utf8');
      const issues = checkPrefabLua(text, f, tileExists);
      stats.tiles += issues.tiles;
      problems.push(...issues.problems);
    }
  } else if (hasWorldgenOverride) {
    problems.push('WorldGenOverride.lua exists but there is no prefab directory');
  }

  // ---- static modules ---------------------------------------------------
  const overridePath = path.join(mapDir, 'WorldGenOverride.lua');
  if (hasWorldgenOverride) {
    const text = fs.readFileSync(overridePath, 'utf8');
    for (const m of text.matchAll(/prefab = worldgen\.prefabs\.(\w+)/g)) {
      stats.modules++;
      if (!known.has(m[1])) problems.push(`WorldGenOverride references unknown prefab ${m[1]}`);
    }
    for (const m of text.matchAll(/xmin = (-?\d+), xmax = (-?\d+), ymin = (-?\d+), ymax = (-?\d+)/g)) {
      const [, xmin, xmax, ymin, ymax] = m.map(Number);
      if (xmax < xmin || ymax < ymin) problems.push(`inverted module rect ${xmin},${ymin}..${xmax},${ymax}`);
      if (xmin < 0 || ymin < 0) problems.push(`module at negative coordinates ${xmin},${ymin}`);
    }
  }

  // ---- the in-game map --------------------------------------------------
  //
  // Checked here because it is the one thing in the mod that can be silently
  // destroyed *after* a good build. The map screen loads an empty `.bin` without
  // complaint and draws nothing, so a blank map looks identical to a working
  // one until somebody opens it. Both times it has been reported, the cells were
  // fine and only this file was empty.
  const mapBin = path.join(mapDir, 'worldmap.xml.bin');
  const mapXml = path.join(mapDir, 'worldmap.xml');
  if (!fs.existsSync(mapXml)) {
    // Both map screens look the name up through `ZomboidFileSystem.activeFileMap`,
    // a table built while the mods are scanned. No name at startup, no map for
    // the whole session however good the `.bin` beside it is.
    problems.push('worldmap.xml is missing, so neither the map nor the minimap will look for the map data');
  }
  if (!fs.existsSync(mapBin)) {
    problems.push('worldmap.xml.bin is missing — the map screen will be blank');
  } else {
    try {
      const map = decodeWorldMapBin(fs.readFileSync(mapBin));
      stats.mapCells = map.cells?.length ?? 0;
      stats.mapFeatures = (map.cells ?? []).reduce((n, c) => n + (c.features?.length ?? 0), 0);
      if (!stats.mapFeatures) {
        problems.push(
          `worldmap.xml.bin has no features in it (${map.width}x${map.height}, ${stats.mapCells} cells) — `
            + 'the map and minimap will be blank. Re-run `npm run world` with Project Zomboid closed.',
        );
      }
    } catch (err) {
      problems.push(`worldmap.xml.bin will not read: ${err.message}`);
    }
  }

  log(
    `verified ${stats.cells} cells, ${stats.prefabs} prefabs (${stats.tiles} tile references), ` +
      `${stats.modules} placements`,
  );
  if (stats.mapFeatures) log(`  in-game map: ${stats.mapFeatures} features in ${stats.mapCells} cells`);
  return { problems, stats };
}

/**
 * Parse an emitted prefab back out of its Lua and check it against the game's
 * tile catalogue and its own declared dimensions.
 */
export function checkPrefabLua(text, label, tileExists) {
  const problems = [];
  let tiles = 0;

  const dim = /dimensions = \{ (\d+), (\d+) \}/.exec(text);
  if (!dim) {
    problems.push(`${label}: no dimensions`);
    return { problems, tiles };
  }
  const w = +dim[1];
  const h = +dim[2];

  const paletteBlock = /tiles = \{([\s\S]*?)\n    \},/.exec(text);
  const palette = paletteBlock ? [...paletteBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  if (!palette.length) problems.push(`${label}: empty tile palette`);

  for (const tile of palette) {
    tiles++;
    if (!tileExists(tile)) problems.push(`${label}: unknown tile ${tile}`);
  }

  const schematic = /schematic = \{([\s\S]*)\n    \}/.exec(text);
  if (!schematic) {
    problems.push(`${label}: no schematic`);
    return { problems, tiles };
  }

  for (const layerMatch of schematic[1].matchAll(/(\w+) = \{([\s\S]*?)\n        \}/g)) {
    const layer = layerMatch[1];
    const rows = [...layerMatch[2].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (rows.length !== h) {
      problems.push(`${label}: layer ${layer} has ${rows.length} rows, expected ${h}`);
    }
    for (const [i, row] of rows.entries()) {
      const cells = row.split(',');
      if (cells.length !== w) {
        problems.push(`${label}: layer ${layer} row ${i} has ${cells.length} columns, expected ${w}`);
        break;
      }
      for (const c of cells) {
        const idx = Number(c);
        if (!Number.isInteger(idx) || idx < 0 || idx > palette.length) {
          problems.push(`${label}: layer ${layer} row ${i} has out-of-range index ${c}`);
          break;
        }
      }
    }
  }

  return { problems, tiles };
}
