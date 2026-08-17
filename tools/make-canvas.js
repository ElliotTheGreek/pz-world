#!/usr/bin/env node
/**
 * Build the blank canvas world that the mod ships.
 *
 * This is the one piece of binary map data pz-world needs, and it is
 * deliberately **city-agnostic**: the same empty cells whatever coordinates the
 * player types in. Everything that makes it a particular city — roads,
 * buildings, ground — is added at runtime from Lua through
 * `worldgen.static_modules`, which is why nothing here mentions a place.
 *
 * Why it has to exist at all: Project Zomboid Lua writes text only
 * (`getModFileWriter` hands back an `OutputStreamWriter`), so the game cannot
 * author `.lotheader` / `.lotpack` / biome PNGs while it runs. Shipping empty
 * ones solves that once.
 *
 * Why it makes the world *ours*: `WorldSelect:hasChoices()` shows the
 * world-picker when `MapGroups:getNumberOfGroups() > 1`, and a group holding a
 * single map directory is named after that map's `title`. A map that declares
 * no `lots=` does not join Knox County's group — it forms its own. So this
 * canvas is a separate world, listed under its own name, not a district bolted
 * onto Muldraugh.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeLotHeader, emptyLotHeader, CELL_SIZE } from '../src/formats/lotheader.js';
import { writeLotPack, emptyLotPack } from '../src/formats/lotpack.js';
import { encodeIndexedPng } from '../src/formats/png.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** The name the world appears under in the picker. Generic on purpose. */
export const MAP_NAME = 'PZWorld';
export const MOD_ID = 'pzworld';

/**
 * Cells per side. 80 × 256 = 20,480 squares ≈ 20.5 km across.
 *
 * That is larger than any city this mod generates needs, and the extra is not for the
 * city. A great many mods hardcode Knox County coordinates — RV Life puts its trailer
 * interiors at x 16,896–18,176 — and a coordinate that falls outside the canvas has no
 * cell, so `IsoLot.getHeader` returns null and whatever the mod was doing fails silently.
 * Knox County's own extent is 78 × 63 cells, so 80 covers every coordinate a mod could
 * reasonably have baked in against vanilla.
 *
 * It was 64 (16.4 km), which covered the city and nothing else. An empty cell is ~19.6 kB,
 * so the canvas costs about 126 MB instead of 80 MB. See mod-src/client/PZWorld_Compat.lua.
 */
export const CANVAS_CELLS = 80;

/**
 * Default ground. 96 is `$random` / DeepForest in
 * `media/lua/server/metazones/BiomeMapConfig.lua` — the same value vanilla uses
 * for untouched wilderness, so anywhere the generated city does not reach fades
 * into forest instead of ending at a hard line.
 */
export const DEFAULT_BIOME = 96;

/**
 * `chunkdata_<cx>_<cy>.bin` accompanies every shipped cell. A wilderness cell's
 * is 1,026 bytes: two header bytes then one per chunk. Only that form is
 * understood — see docs/PZ-FORMATS.md.
 */
function emptyChunkData() {
  const buf = Buffer.alloc(2 + 32 * 32);
  buf[0] = 0x00;
  buf[1] = 0x01;
  return buf;
}

/**
 * The map goes in `common/`, not in the version directory, and that is not a
 * style choice — it works around a bug in `zombie.MapGroups.createGroups`.
 *
 * The method scans a mod's map directories in two passes, common first and the
 * version directory second. But the common pass is written as:
 *
 *     66: mod.getCommonDir() + "/media/maps/"
 *     81: File.exists()
 *     84: ifne -> 90        // exists: scan it
 *     87: goto -> 23        // MISSING: jump to the next mod
 *    164: mod.getVersionDir() + "/media/maps/"   // never reached
 *
 * so a mod with no `common/media/maps/` never has its version directory
 * scanned. A map placed only in `42/media/maps/` is invisible to the world
 * grouping — confirmed in-game: with vanilla excluded, `createGroups` found
 * exactly one mod map across nine active mods, `RV_B`, which lives in
 * `FifthWheel/common/media/maps/`.
 *
 * Putting the map in `common/` sidesteps the broken branch entirely. It is also
 * correct on its own terms: this map has no per-build content.
 */
export function buildCanvas(outDir, { cells = CANVAS_CELLS, log = () => {} } = {}) {
  const mapDir = path.join(outDir, 'media/maps', MAP_NAME);
  const biomeDir = path.join(mapDir, 'maps');
  fs.mkdirSync(biomeDir, { recursive: true });

  // Identical bytes for every cell, so this is built once and written many
  // times rather than re-encoded per cell.
  const header = writeLotHeader(emptyLotHeader([]));
  const pack = writeLotPack(emptyLotPack(1));
  const chunk = emptyChunkData();
  const biome = encodeIndexedPng({
    width: CELL_SIZE,
    height: CELL_SIZE,
    pixels: new Uint8Array(CELL_SIZE * CELL_SIZE).fill(DEFAULT_BIOME),
  });

  let bytes = 0;
  for (let cx = 0; cx < cells; cx++) {
    for (let cy = 0; cy < cells; cy++) {
      fs.writeFileSync(path.join(mapDir, `${cx}_${cy}.lotheader`), header);
      fs.writeFileSync(path.join(mapDir, `world_${cx}_${cy}.lotpack`), pack);
      fs.writeFileSync(path.join(mapDir, `chunkdata_${cx}_${cy}.bin`), chunk);
      fs.writeFileSync(path.join(biomeDir, `biomemap_${cx}_${cy}.png`), biome);
      bytes += header.length + pack.length + chunk.length + biome.length;
    }
  }

  const middle = Math.round((cells * CELL_SIZE) / 2);

  // `lots=` names **our own directory**, not Muldraugh's.
  //
  // This line is what registers the map at all. `ChooseGameInfo` parses `lots=`
  // into the map's lot-directory list and `MapGroups` builds its groups from
  // `getLotDirectories()`; a mod map that declares nothing contributes no
  // directories, forms no group, and is never listed — which is exactly what
  // happened with no `lots=` line at all. Muldraugh gets away without one only
  // because vanilla directories are added separately by
  // `getVanillaMapDirectories`.
  //
  // Pointing it at ourselves registers the directory without pulling Knox
  // County into the group, so `usesVanilla` stays false, vanilla is not added,
  // and this remains a separate world.
  fs.writeFileSync(
    path.join(mapDir, 'map.info'),
    [
      `title=${MAP_NAME}`,
      `lots=${MAP_NAME}`,
      'fixed2x=true',
      'description=Chunk size is 8x8, Cell size is 256x256',
      `zoomX=${middle}`,
      `zoomY=${middle}`,
      'zoomS=13.5',
      '',
    ].join('\n'),
    'utf8',
  );

  // A placeholder spawn at the centre. The real spawn is rewritten by the mod
  // once it knows where the generated city actually put its houses.
  fs.writeFileSync(
    path.join(mapDir, 'spawnpoints.lua'),
    [
      'function SpawnPoints()',
      '  return {',
      '    unemployed = {',
      `      { posX = ${middle}, posY = ${middle}, posZ = 0 },`,
      '    },',
      '  }',
      'end',
      '',
    ].join('\n'),
    'utf8',
  );

  fs.writeFileSync(path.join(mapDir, 'objects.lua'), 'objects = {}\n', 'utf8');

  // A plain thumbnail; every vanilla town folder carries one.
  const thumbPx = new Uint8Array(256 * 256).fill(DEFAULT_BIOME);
  const palette = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) {
    palette[i * 3] = 60;
    palette[i * 3 + 1] = 90;
    palette[i * 3 + 2] = 60;
  }
  fs.writeFileSync(
    path.join(mapDir, 'thumb.png'),
    encodeIndexedPng({ width: 256, height: 256, pixels: thumbPx, palette }),
  );

  log(`canvas: ${cells}×${cells} cells (${cells * CELL_SIZE} squares), ${(bytes / 1e6).toFixed(1)} MB`);
  return { mapDir, cells, squares: cells * CELL_SIZE, bytes };
}

export function writeModInfo(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'mod.info'),
    [
      'name=pz-world',
      `id=${MOD_ID}`,
      'description=Build a Project Zomboid world from anywhere on Earth. Enter coordinates',
      'description=when you start a new game and the world is generated in front of you.',
      'description=Map data © OpenStreetMap contributors, ODbL 1.0',
      'author=pz-world',
      'versionMin=42.0.0',
      'pzversion=42',
      '',
    ].join('\n'),
    'utf8',
  );
}

// `pathToFileURL` rather than string-building the URL: on Windows
// `import.meta.url` is `file:///C:/...` with three slashes and a hand-rolled
// comparison silently never matches, so the script does nothing and exits 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mod = path.join(ROOT, 'mod');
  const cells = Number(process.argv[2] ?? CANVAS_CELLS);
  // mod.info and Lua live in the version directory; the map lives in common/
  // so that MapGroups actually scans it (see buildCanvas).
  writeModInfo(path.join(mod, '42'));
  buildCanvas(path.join(mod, 'common'), { cells, log: (m) => process.stdout.write(`${m}\n`) });
  process.stdout.write(`wrote ${mod}\n`);
}
