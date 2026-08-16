#!/usr/bin/env node
/**
 * Build a real city into the installed mod.
 *
 * ```
 * npm run world -- --lat 44.6995 --lon -73.4529 --radius 2500 --name "Plattsburgh, NY"
 * ```
 *
 * Everything the world is made of comes out of this one command: authored map cells with
 * every storey and every roof, the biome maps that stop the game regenerating them, the
 * collision summary, the in-game map, and the street names.
 *
 * ## Why this is a command and not something the mod does
 *
 * Project Zomboid's Lua writes **text only** — `getModFileWriter` returns an
 * `OutputStreamWriter` over UTF-8, so every byte above 0x7F comes out as two. Map cells
 * are binary. So the world cannot be authored from inside the game at all, and the
 * runtime `worldgen` route that can be driven from Lua is limited to what
 * `PrefabStructure` expresses: four tile layers, one storey, no roof.
 *
 * The files have to be in place **before the world loads**, which is exactly what this
 * gives: run it, then start a new game.
 *
 * ## Two things to know before running it
 *
 *   - **Quit the game first.** `IsoLot.pool` keeps file handles open on recently used
 *     lotpacks, and on Windows a rewrite of an open file fails outright (DEV_GUIDE §1.5
 *     has the same warning for a different reason).
 *   - **Start a new save.** `IsoChunk.LoadOrCreate` prefers a chunk's save file over the
 *     lotpack, so anywhere you have already walked keeps the old world.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fetchArea, normalise, checkRadius, ATTRIBUTION } from '../src/sources/osm.js';
import { bboxAround } from '../src/geo/project.js';
import { generateWorld } from '../src/emit/generate.js';
import { buildWorldMapDoc, encodeWorldMap } from '../src/emit/worldmap.js';
import { loadTileCatalogue } from '../src/formats/tiledefs.js';
import { findInstall, findUserFolder } from '../src/lib/pzinstall.js';
import { indexInstall } from '../src/extract/building.js';
import { MAP_NAME, MOD_ID } from './make-canvas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LIBRARY = path.join(ROOT, 'library/buildings.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/**
 * The building index, built on demand.
 *
 * Only *where* each building is — map, cell, bounds, class — never its tiles. Those are
 * read out of the install at generate time, which keeps this small and keeps the
 * property `docs/PROTOTYPES.md` rests on: nothing derived from The Indie Stone's data is
 * stored in bulk or redistributed.
 */
const LIBRARY_VERSION = 2; // 2: carries roomIds, so a building keeps only its own rooms

export function loadLibrary(install, { log = () => {} } = {}) {
  if (fs.existsSync(LIBRARY)) {
    const parsed = JSON.parse(fs.readFileSync(LIBRARY, 'utf8'));
    if (parsed.version === LIBRARY_VERSION && parsed.buildings?.length) return parsed.buildings;
    if (parsed.buildings?.length) log('the building index is from an older format; re-indexing');
  }
  log('indexing buildings from your Project Zomboid install (once)...');
  const { buildings, stats } = indexInstall(install, {
    onProgress: (m) => process.stdout.write(`\r  ${m}   `),
  });
  process.stdout.write('\n');
  log(`indexed ${stats.buildings} buildings across ${stats.cells} cells`);
  fs.mkdirSync(path.dirname(LIBRARY), { recursive: true });
  fs.writeFileSync(LIBRARY, JSON.stringify({ version: LIBRARY_VERSION, buildings }));
  return buildings;
}

export async function buildWorld(opts) {
  const log = opts.log ?? ((m) => process.stdout.write(`${m}\n`));
  const install = findInstall();
  const mapDir =
    opts.mapDir ?? path.join(findUserFolder(), 'mods', MOD_ID, 'common/media/maps', MAP_NAME);

  if (!fs.existsSync(mapDir)) {
    throw new Error(
      `no installed map at ${mapDir}. Run \`npm run canvas\` and \`npm run build\` first.`,
    );
  }

  const lat = Number(opts.lat);
  const lon = Number(opts.lon);
  const radiusM = Number(opts.radius ?? 2500);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('--lat and --lon are required');
  checkRadius(radiusM);

  // Progress is reported by *stage*, not by a running count, because the stages take
  // wildly different times and a bar that spends four minutes between 30% and 31% reads
  // as a hang. The build screen shows the stage name beside the bar for the same reason.
  const onProgress = opts.onProgress ?? (() => {});

  log(`building ${opts.name ?? 'the world'} at ${lat}, ${lon}, radius ${radiusM} m`);
  onProgress({ stage: 'fetching', progress: 0.02, message: 'Reading your Project Zomboid install' });
  const catalogue = loadTileCatalogue(install);
  const library = loadLibrary(install, { log });

  onProgress({ stage: 'fetching', progress: 0.05, message: 'Asking OpenStreetMap for the area' });
  const bbox = bboxAround(lat, lon, radiusM);
  const raw = await fetchArea(bbox, {
    cacheDir: path.join(ROOT, 'cache'),
    refresh: !!opts.refresh,
    log,
  });
  const features = normalise(raw);
  log(`${features.buildings.length} buildings, ${features.roads.length} roads, ${features.ground.length} land-cover areas`);

  const result = generateWorld(features, {
    lat,
    lon,
    radiusM,
    bbox,
    seed: opts.seed ?? `${lat},${lon}`,
    library,
    catalogue,
    mapDir,
    log: (m) => log(`  ${m}`),
    onProgress,
  });

  onProgress({ stage: 'extras', progress: 0.92, message: 'Drawing the in-game map' });

  // ---- the in-game map ---------------------------------------------------
  const doc = buildWorldMapDoc({
    placements: result.placements,
    roads: result.roads,
    cover: result.cover ?? [],
    bounds: result.bounds,
  });
  const bin = encodeWorldMap(doc);
  fs.writeFileSync(path.join(mapDir, 'worldmap.xml.bin'), bin);
  // A stale `.xml` beside it would be read only if the `.bin` were missing, and the
  // game's XML reader is broken — so it is removed rather than left to be found.
  fs.rmSync(path.join(mapDir, 'worldmap.xml'), { force: true });
  log(`  map: ${doc.features} features in ${doc.cells.length} cells, ${(bin.length / 1e6).toFixed(1)} MB`);

  writeSpawnPoints(mapDir, result);
  writeAttribution(mapDir, { lat, lon, radiusM, name: opts.name });

  log('');
  log(`${result.stats.cells} cells written, ${(result.stats.bytes / 1e6).toFixed(0)} MB`);
  log(`${result.stats.placed} buildings, ${result.stats.rooms} rooms, ${result.stats.streets} street records`);
  const byClass = [...result.stats.byClass].sort((a, b) => b[1] - a[1]);
  log(`  ${byClass.map(([k, v]) => `${k}:${v}`).join('  ')}`);
  if (result.stats.incompleteChunks) {
    log(`  WARNING: ${result.stats.incompleteChunks} chunks are not full at level 0 and will be regenerated`);
  }
  onProgress({
    stage: 'extras',
    progress: 1,
    message: `${result.stats.placed} buildings, ${result.stats.rooms} rooms, ${result.stats.cells} cells`,
  });

  log('');
  log('Quit Project Zomboid before running this, and start a NEW save to see the world.');
  return result;
}

/** Spawn every profession where the town actually is. */
function writeSpawnPoints(mapDir, result) {
  const placed = result.placements;
  if (!placed.length) return;
  let sx = 0;
  let sy = 0;
  for (const p of placed) {
    sx += p.x;
    sy += p.y;
  }
  const x = Math.round(sx / placed.length);
  const y = Math.round(sy / placed.length);
  const professions = ['unemployed', 'police', 'fireofficer', 'parkranger', 'constructionworker', 'securityguard'];
  const body = [
    'function SpawnPoints()',
    '\treturn {',
    ...professions.map((p) => `\t\t${p} = { { worldX = 0, worldY = 0, posX = ${x}, posY = ${y}, posZ = 0 } },`),
    '\t}',
    'end',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(mapDir, 'spawnpoints.lua'), body, 'utf8');
}

function writeAttribution(mapDir, meta) {
  fs.writeFileSync(
    path.join(mapDir, 'ATTRIBUTION.txt'),
    [
      `${meta.name ?? 'Generated world'} — ${meta.lat}, ${meta.lon}, radius ${meta.radiusM} m`,
      '',
      ATTRIBUTION,
      '',
      'Building interiors are derived from this machine\'s own Project Zomboid installation',
      'and are not redistributed by this project.',
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * Write the progress file the in-game build screen polls.
 *
 * Kept here rather than in the helper because the helper runs the build in a **child
 * process** — see `handleBuildOrder` in helper/serve.js — so this is the only process
 * that knows how far along it is. The format is the mod's own (`Bridge.readProgress`),
 * terminated with `end` so a reader that catches a partial write can tell.
 */
export function writeProgressFile(file, { stage = '', progress = 0, message = '', done = false, err = '' }) {
  fs.writeFileSync(
    file,
    [
      `progress ${progress.toFixed(4)}`,
      `done ${done ? 1 : 0}`,
      `error ${err}`,
      `stage ${stage}`,
      `message ${message}`,
      'end',
      '',
    ].join('\r\n'),
    'utf8',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  // `--progress <file>` is how a build ordered from inside the game reports back.
  const progressFile = args.progress ? String(args.progress) : null;
  if (progressFile) {
    args.onProgress = (p) => writeProgressFile(progressFile, p);
  }
  buildWorld(args)
    .then((result) => {
      if (!progressFile) return;
      writeProgressFile(progressFile, {
        stage: 'extras',
        progress: 1,
        done: true,
        message:
          `${result.stats.placed} buildings, ${result.stats.rooms} rooms, ` +
          `${result.stats.cells} cells, ${result.stats.stalls} parking stalls`,
      });
    })
    .catch((err) => {
      process.stderr.write(`${err.stack}\n`);
      // The screen is blocking the player, so a build that dies has to say so itself.
      // The helper only sees an exit code, and a crashed process writes nothing at all.
      if (progressFile) {
        writeProgressFile(progressFile, {
          stage: 'extras',
          progress: 0,
          done: true,
          message: 'Build failed',
          err: err.message,
        });
      }
      process.exit(1);
    });
}
