/**
 * Writing the mod.
 *
 * This is the route that matches what the player asked for: the mod ships text
 * and small PNGs, and Project Zomboid assembles the world itself on first load,
 * on the `WorldGenerateThread` described in `zombie/iso/WorldGenerate`. Nothing
 * here writes tile data — it writes *instructions*.
 *
 * Four kinds of file do all the work:
 *
 *   media/lua/server/WorldGen/prefabs/*.lua   the buildings and road patches,
 *                                             in the format PrefabStructure
 *                                             loads: dimensions, a tile
 *                                             palette, and a schematic per layer
 *   media/maps/<Name>/WorldGenOverride.lua    a StaticModule per placement,
 *                                             `{prefab, xmin, xmax, ymin, ymax}`
 *   media/maps/<Name>/maps/biomemap_*.png     ground, vegetation and zones,
 *                                             one grey per square
 *   media/maps/<Name>/<cx>_<cy>.lotheader     empty cells, so the cell exists
 *   media/maps/<Name>/world_<cx>_<cy>.lotpack
 *
 * The one thing that cannot happen inside the game is the *download*. Project
 * Zomboid's Lua sandbox has no HTTP client and cannot write map data, so
 * fetching OpenStreetMap and working out the plan happens here, in Node, before
 * the game starts. Assembling that plan into a world genuinely does happen on
 * first load.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CELL_SIZE } from '../formats/lotheader.js';
import { writeLotHeader, emptyLotHeader } from '../formats/lotheader.js';
import { writeLotPack, emptyLotPack } from '../formats/lotpack.js';
import { encodeIndexedPng } from '../formats/png.js';
import { Schematic, LAYERS } from '../prefab/schematic.js';
import { ATTRIBUTION } from '../sources/osm.js';
import { hashString } from '../lib/rng.js';

/**
 * Road patches are cut to this size before becoming prefabs.
 *
 * One prefab per road *segment* would be tens of thousands of static modules;
 * one prefab for the whole city would be a single sparse array the size of the
 * map. Cutting the painted roads into fixed patches keeps both the module count
 * and each prefab's area bounded, and empty patches cost nothing because they
 * are never emitted.
 */
const ROAD_PATCH = 32;

/**
 * The build this mod targets. Project Zomboid looks for `<mod>/42/mod.info`
 * and `<mod>/42/media/` when running Build 42; anything at the mod root is
 * treated as Build 41 content.
 */
const MOD_VERSION_DIR = '42';

/**
 * @param {object} plan  from src/plan/index.js
 * @param {{out: string, name: string, author?: string, description?: string,
 *          log?: Function}} opts
 */
export function emitMod(plan, opts) {
  const log = opts.log ?? (() => {});
  const out = opts.out;
  const mapName = opts.name;
  const modId = `pzworld_${slug(mapName)}`;

  // Build 42 mods live in a version subfolder. A Workshop mod supporting both
  // builds carries `mod.info` + `media/` at the root for B41 and the same pair
  // again under `42/`; of the 78 installed here, 26 have *only* `42/mod.info`
  // and no root one at all. Everything at the root is therefore read as a B41
  // mod, and B42 does not list it.
  const modRoot = path.join(out, MOD_VERSION_DIR);
  const mapDir = path.join(modRoot, 'media/maps', mapName);
  const biomeDir = path.join(mapDir, 'maps');
  const prefabDir = path.join(modRoot, 'media/lua/server/WorldGen/prefabs');

  fs.mkdirSync(biomeDir, { recursive: true });
  fs.mkdirSync(prefabDir, { recursive: true });

  // ---- prefabs ----------------------------------------------------------
  // The same prototype at the same rotation is emitted once however many times
  // the city uses it. A street of forty identical houses costs one prefab file
  // and forty static modules.
  const prefabs = new Map();
  const modules = [];

  const roadPrefabs = buildRoadPatches(plan.roads);
  for (const patch of roadPrefabs) {
    const key = registerPrefab(prefabs, patch.schematic);
    modules.push({ prefab: key, x: patch.x, y: patch.y, w: patch.schematic.w, h: patch.schematic.h });
  }
  log(`road patches: ${roadPrefabs.length}`);

  for (const p of plan.placements) {
    const key = registerPrefab(prefabs, p.schematic);
    modules.push({ prefab: key, x: p.x, y: p.y, w: p.schematic.w, h: p.schematic.h });
  }

  let prefabBytes = 0;
  for (const [name, schematic] of prefabs) {
    const lua = schematic.toLua();
    prefabBytes += lua.length;
    fs.writeFileSync(path.join(prefabDir, `${name}.lua`), lua, 'utf8');
  }
  log(`${prefabs.size} distinct prefabs, ${modules.length} placements, ${kb(prefabBytes)} of Lua`);

  // ---- WorldGenOverride -------------------------------------------------
  fs.writeFileSync(
    path.join(mapDir, 'WorldGenOverride.lua'),
    renderWorldGenOverride(modules, plan),
    'utf8',
  );

  // ---- biome maps and empty cells ---------------------------------------
  const cells = plan.ground.list();
  const header = writeLotHeader(emptyLotHeader([]));
  const pack = writeLotPack(emptyLotPack(1));
  const chunkData = emptyChunkData();

  for (const { cx, cy, data } of cells) {
    if (cx < 0 || cy < 0) continue; // cells are indexed from zero
    fs.writeFileSync(
      path.join(biomeDir, `biomemap_${cx}_${cy}.png`),
      encodeIndexedPng({ width: CELL_SIZE, height: CELL_SIZE, pixels: data }),
    );
    fs.writeFileSync(path.join(mapDir, `${cx}_${cy}.lotheader`), header);
    fs.writeFileSync(path.join(mapDir, `world_${cx}_${cy}.lotpack`), pack);
    fs.writeFileSync(path.join(mapDir, `chunkdata_${cx}_${cy}.bin`), chunkData);
  }
  log(`${cells.length} cells written`);

  // ---- metadata ---------------------------------------------------------
  fs.writeFileSync(path.join(mapDir, 'map.info'), renderMapInfo(plan, mapName, opts), 'utf8');
  fs.writeFileSync(path.join(mapDir, 'thumb.png'), renderThumb(plan));
  fs.writeFileSync(path.join(mapDir, 'objects.lua'), 'objects = {}\n', 'utf8');
  fs.writeFileSync(path.join(mapDir, 'spawnpoints.lua'), renderSpawnpoints(plan), 'utf8');
  fs.writeFileSync(
    path.join(modRoot, 'mod.info'),
    renderModInfo(modId, mapName, plan, opts),
    'utf8',
  );
  fs.writeFileSync(path.join(modRoot, 'README.txt'), renderReadme(mapName, plan), 'utf8');

  return {
    modId,
    mapName,
    out,
    prefabs: prefabs.size,
    modules: modules.length,
    cells: cells.length,
  };
}

function registerPrefab(prefabs, schematic) {
  // Name from content, so an identical prefab produced twice collapses into one
  // file and the mod is stable across regenerations.
  const fingerprint = JSON.stringify([
    schematic.w,
    schematic.h,
    LAYERS.map((l) => schematic.layers.get(l)),
  ]);
  const name = `pzw_${hashString(fingerprint).toString(16)}`;
  if (!prefabs.has(name)) {
    const copy = schematic.clone(name);
    prefabs.set(name, copy);
  }
  return name;
}

/**
 * Cut the painted road canvas into fixed patches and turn each into a prefab.
 */
function buildRoadPatches(canvas) {
  if (!canvas.size) return [];
  /** @type {Map<string, {x:number, y:number, squares: object[]}>} */
  const patches = new Map();

  for (const { x, y, layers } of canvas.entries()) {
    const px = Math.floor(x / ROAD_PATCH);
    const py = Math.floor(y / ROAD_PATCH);
    const key = `${px},${py}`;
    let patch = patches.get(key);
    if (!patch) {
      patches.set(key, (patch = { x: px * ROAD_PATCH, y: py * ROAD_PATCH, squares: [] }));
    }
    patch.squares.push({ x, y, layers });
  }

  const out = [];
  for (const patch of patches.values()) {
    // Trim to what the patch actually contains. A diagonal street crossing a
    // 32 × 32 patch touches a few hundred of its 1,024 squares, and an
    // untrimmed prefab writes the rest as literal zeroes — which is most of
    // the emitted Lua, for nothing.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const sq of patch.squares) {
      if (sq.x < minX) minX = sq.x;
      if (sq.y < minY) minY = sq.y;
      if (sq.x > maxX) maxX = sq.x;
      if (sq.y > maxY) maxY = sq.y;
    }
    if (!Number.isFinite(minX)) continue;

    // margin 0: a road patch has no walls, so there is no east or south edge
    // to reserve space for.
    const s = new Schematic({
      name: 'road',
      cls: 'road',
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      margin: 0,
      zombies: 0,
    });
    for (const sq of patch.squares) {
      for (const [layer, tile] of Object.entries(sq.layers)) {
        s.set(layer, sq.x - minX, sq.y - minY, tile);
      }
    }
    if (!s.isEmpty) out.push({ x: minX, y: minY, schematic: s });
  }
  return out;
}

function renderWorldGenOverride(modules, plan) {
  const lines = [];
  lines.push('-- Generated by pz-world. Do not edit by hand; regenerate instead.');
  lines.push(`-- ${plan.meta.name}: ${plan.meta.lat}, ${plan.meta.lon}`);
  lines.push(`-- ${ATTRIBUTION}`);
  lines.push('');
  lines.push('worldgen["static_modules"] = {');
  const body = modules.map(
    (m) =>
      `    {\n` +
      `        position = { xmin = ${m.x}, xmax = ${m.x + m.w - 1}, ` +
      `ymin = ${m.y}, ymax = ${m.y + m.h - 1} },\n` +
      `        prefab = worldgen.prefabs.${m.prefab}\n` +
      `    }`,
  );
  lines.push(body.join(',\n'));
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/**
 * `lots=` is what joins this map to the base world, and it is required.
 *
 * Build 42 has **one** world with many spawn regions, not many worlds. Every
 * shipped town except Muldraugh holds zero cells and carries
 * `lots=Muldraugh, KY`; Muldraugh alone has the 4,065 cells and is the world
 * itself. A map that declares no `lots` forms its own map group — a rival
 * world — and the game simply keeps the vanilla one, so the town never appears
 * in the location list. That is exactly what happened on the first attempt.
 *
 * Declaring the base map puts this town in the same group, so its cells are
 * added to Knox County and its spawn points become a selectable location.
 *
 * Also note what the four locations offered in a normal new game are: the four
 * vanilla towns *without* `only_for_game_mode=Sandbox`. The other seven set it
 * and appear only in Sandbox. We deliberately do not set it.
 */
function renderMapInfo(plan, mapName, opts) {
  const { bounds } = plan.meta;
  return [
    `title=${mapName}`,
    `lots=${opts.baseMap ?? 'Muldraugh, KY'}`,
    'fixed2x=true',
    'description=Chunk size is 8x8, Cell size is 256x256',
    `zoomX=${Math.round((bounds.minX + bounds.maxX) / 2)}`,
    `zoomY=${Math.round((bounds.minY + bounds.maxY) / 2)}`,
    'zoomS=13.5',
    '',
  ].join('\n');
}

/**
 * Spawn points are **absolute world square coordinates** in B42 — Ekron's file
 * reads `{ posX = 411, posY = 9761, posZ = 0 }`. The B41 form with `worldX` and
 * `worldY` cell indices plus a local offset is not what the shipped files use.
 *
 * Points are placed on real buildings rather than at the geometric centre,
 * which could easily be the middle of a road or a lake.
 */
function renderSpawnpoints(plan) {
  const { bounds } = plan.meta;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  const houses = plan.placements
    .filter((p) => p.cls === 'house' || p.cls === 'apartment')
    .sort(
      (a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy),
    )
    .slice(0, 10);

  const chosen = houses.length ? houses : plan.placements.slice(0, 1);
  const points = chosen.length
    ? chosen.map(
        (p) =>
          `      { posX = ${Math.round(p.x + p.w / 2)}, posY = ${Math.round(p.y + p.h / 2)}, posZ = 0 },`,
      )
    : [`      { posX = ${Math.round(cx)}, posY = ${Math.round(cy)}, posZ = 0 },`];

  // Every profession draws from the same list; a real spawn table wants zones,
  // which the worldgen route cannot declare yet (docs/LIMITATIONS.md).
  const professions = ['unemployed'];
  const body = professions
    .map((p) => [`    ${p} = {`, ...points, '    },'].join('\n'))
    .join('\n');

  return ['function SpawnPoints()', '  return {', body, '  }', 'end', ''].join('\n');
}

function renderModInfo(modId, mapName, plan, opts) {
  return [
    `name=${mapName} (pz-world)`,
    `id=${modId}`,
    `description=A Project Zomboid map generated from the real ${mapName} by pz-world.`,
    `description=Centre ${plan.meta.lat}, ${plan.meta.lon}; radius ${plan.meta.radiusM} m; seed ${plan.meta.seed}.`,
    `description=Map data ${ATTRIBUTION}`,
    `author=${opts.author ?? 'pz-world'}`,
    // Both spellings appear across installed B42 mods; `versionMin` with a full
    // build number is what the 42-only ones use.
    'versionMin=42.0.0',
    'pzversion=42',
    '',
  ].join('\n');
}

function renderReadme(mapName, plan) {
  const s = plan.stats;
  return [
    `${mapName} — generated by pz-world`,
    '',
    `Centre:   ${plan.meta.lat}, ${plan.meta.lon}`,
    `Radius:   ${plan.meta.radiusM} m`,
    `Seed:     ${plan.meta.seed}`,
    `Rotation: ${plan.meta.bearing.toFixed(2)}° (road/grid alignment ` +
      `${(100 * plan.meta.alignment.before).toFixed(1)}% → ${(100 * plan.meta.alignment.after).toFixed(1)}%)`,
    '',
    `Buildings placed: ${s.buildings.placed} of ${s.buildings.total}`,
    `Roads:            ${s.roads.ways} ways over ${s.roads.squares} squares`,
    `Snap residual:    median ${s.residual.median.toFixed(1)}°, ` +
      `90th ${s.residual.p90.toFixed(1)}°, worst ${s.residual.max.toFixed(1)}°`,
    '',
    'Map data © OpenStreetMap contributors, licensed under the Open Database',
    'Licence (ODbL) 1.0. See https://www.openstreetmap.org/copyright',
    '',
    'Building prototypes are generated on your own machine from your own copy of',
    'Project Zomboid and are not redistributed by pz-world.',
    '',
  ].join('\n');
}

/**
 * A small preview of the map for the picker. Every vanilla town folder carries
 * one — Ekron's holds exactly `map.info`, `spawnpoints.lua` and `thumb.png`.
 *
 * Drawn straight from the biome map, so it shows the real shape of the
 * generated place: roads and buildings as pale dirt, forest dark, water black.
 */
function renderThumb(plan, size = 256) {
  const { bounds } = plan.meta;
  const worldW = Math.max(1, bounds.maxX - bounds.minX);
  const worldH = Math.max(1, bounds.maxY - bounds.minY);
  const pixels = new Uint8Array(size * size);

  for (let py = 0; py < size; py++) {
    const wy = bounds.minY + Math.floor((py / size) * worldH);
    for (let px = 0; px < size; px++) {
      const wx = bounds.minX + Math.floor((px / size) * worldW);
      pixels[py * size + px] = plan.ground.get(wx, wy);
    }
  }

  // A palette that reads as a map rather than as the raw biome ids.
  const palette = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) {
    let rgb;
    if (i === 0) rgb = [40, 70, 110]; // water
    else if (i === 254) rgb = [200, 190, 170]; // built ground: roads, buildings
    else if (i === 115) rgb = [150, 145, 130]; // town
    else if (i >= 240) rgb = [30, 60, 35]; // deep forest
    else if (i >= 140) rgb = [70, 105, 60]; // forest and farmland
    else rgb = [95, 125, 75]; // open ground
    palette[i * 3] = rgb[0];
    palette[i * 3 + 1] = rgb[1];
    palette[i * 3 + 2] = rgb[2];
  }

  return encodeIndexedPng({ width: size, height: size, pixels, palette });
}

/**
 * `chunkdata_<cx>_<cy>.bin` accompanies every shipped cell. A wilderness cell's
 * is 1,026 bytes — a two-byte header then one byte per chunk — and its contents
 * are not needed to render anything, so new cells copy that shape. Flagged in
 * docs/LIMITATIONS.md as understood-by-shape rather than fully decoded.
 */
function emptyChunkData() {
  const buf = Buffer.alloc(2 + 32 * 32);
  buf[0] = 0x00;
  buf[1] = 0x01;
  return buf;
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function kb(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} kB`;
}
