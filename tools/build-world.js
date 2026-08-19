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
import {
  decodeWorldMapBin,
  encodeWorldMapXml,
  assertXmlMatchesBin,
} from '../src/formats/worldmap.js';
import { loadTileCatalogue } from '../src/formats/tiledefs.js';
import { findInstall, findUserFolder } from '../src/lib/pzinstall.js';
import { indexInstall } from '../src/extract/building.js';
import {
  assertValidSemanticRegistry,
  compatibleSemanticRegistry,
  createAssetCompatibility,
  loadSemanticRegistry,
} from '../src/catalogue/semantic-registry.js';
import { MAP_NAME, MOD_ID, CANVAS_CELLS } from './make-canvas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LIBRARY = path.join(ROOT, 'library/buildings.json');
const ASSET_INVENTORY = path.join(ROOT, 'library/asset-inventory.json');

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
  const inventory = JSON.parse(fs.readFileSync(ASSET_INVENTORY, 'utf8'));
  const sourceRegistry = loadSemanticRegistry();
  const assetCompatibility = createAssetCompatibility(inventory, catalogue);
  const validation = assertValidSemanticRegistry(sourceRegistry, inventory, {
    compatibility: assetCompatibility,
  });
  const semanticRegistry = compatibleSemanticRegistry(sourceRegistry, assetCompatibility);
  if (validation.warnings.length) {
    for (const warning of validation.warnings) log(`  asset warning: ${warning}`);
  }
  log(`validated ${validation.referencedAssets} semantic assets against the installed tilesets`);
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
    semanticRegistry,
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
  // Declared at the canvas's own size, not at the town's.
  //
  // The helper recompiles this file from the XML beside it and forces
  // `CANVAS_CELLS` when it does (`helper/serve.js compileMapIfChanged`). Writing
  // anything else here means the map changes shape the first time the helper
  // ticks. Every cell coordinate is absolute and the canvas contains them all,
  // so declaring the canvas costs nothing and makes the two writers agree.
  doc.width = CANVAS_CELLS;
  doc.height = CANVAS_CELLS;
  doc.originX = 0;
  doc.originY = 0;

  const bin = encodeWorldMap(doc);
  const xml = encodeWorldMapXml(doc);

  // The `.bin` is what the game reads; the `.xml` is what the *helper* reads.
  //
  // Both map screens resolve the name through `ZomboidFileSystem.activeFileMap`,
  // a table built while the mods are scanned, so `worldmap.xml` has to exist at
  // startup or neither screen ever asks for the data — that is one bug. The
  // other is that the helper watches that same file and rebuilds the `.bin` from
  // it on any change, so leaving a *stub* there means the stub becomes the map.
  // Deleting the file fixes the second bug by causing the first.
  //
  // Writing the real map in both forms ends the argument: the name is there for
  // the scan, and the helper recompiling it produces the identical file. The
  // assertion below is what makes that a fact rather than an intention.
  // XML first, then the binary — the order matters while the helper is running.
  //
  // The helper compiles on a change to the `.xml`. Writing the `.bin` first
  // leaves a window in which it can compile the *previous* `.xml` — a stub, or
  // the empty file an interrupted in-game build left behind — straight over the
  // binary just written. With the XML updated first, the worst a tick landing
  // mid-write can do is produce the very bytes the next line writes anyway.
  atomicWrite(path.join(mapDir, 'worldmap.xml'), xml);
  atomicWrite(path.join(mapDir, 'worldmap.xml.bin'), bin);
  assertXmlMatchesBin(xml, bin, { width: CANVAS_CELLS, height: CANVAS_CELLS });

  log(`  map: ${doc.features} features in ${doc.cells.length} cells, `
    + `${(bin.length / 1e6).toFixed(1)} MB binary, ${(xml.length / 1e6).toFixed(1)} MB xml`);
  checkMapOnDisk(mapDir, doc, log);

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

/**
 * Write through a temporary file and rename, so no reader ever sees half a map.
 *
 * `worldmap.xml` is 3.2 MB and the helper polls it every 400 ms to keep the
 * `.bin` in step. A plain `writeFileSync` truncates and refills in place, so a
 * poll landing inside that window reads a file that is part new and part old —
 * and because the tail is still the previous run's, it can even end in a
 * `</world>` and pass the helper's completeness check. Measured while a second
 * helper was watching a build: the map compiled to 9,825 features, then 9,822,
 * where the build had written 9,832. Ten features vanished into a race.
 *
 * `rename` within a directory is atomic, so a reader gets the old file or the
 * new one and never a splice of both. The retry loop is for Windows: the game
 * and the helper both poll these paths, and a rename onto a file somebody holds
 * open fails with EPERM. Failing back to an in-place write is still better than
 * not writing at all, and it is what the old helper did for the same reason.
 */
function atomicWrite(file, body) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
  } catch {
    fs.writeFileSync(file, body);
    return;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') break;
      const until = Date.now() + 10 * 2 ** attempt;
      while (Date.now() < until) { /* no sync sleep is available here */ }
    }
  }
  fs.writeFileSync(file, body);
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* a stray temp file is harmless */
  }
}

/**
 * Read the map back off disk and refuse to finish quietly if it is empty.
 *
 * A blank in-game map has now been reported twice, and both times the build
 * said it had written thousands of features while the file next to the cells
 * held none. Nothing downstream notices: `WorldMapDataAssetManager` loads an
 * empty `.bin` perfectly happily and draws nothing, so the first sign of it is
 * a player opening the map an hour later.
 *
 * Reading the file back costs milliseconds against a six-minute build, and it
 * catches both halves of the failure — a doc that came out empty, and a file
 * that something else replaced between the write and here.
 */
function checkMapOnDisk(mapDir, doc, log) {
  const file = path.join(mapDir, 'worldmap.xml.bin');
  let back;
  try {
    back = decodeWorldMapBin(fs.readFileSync(file));
  } catch (err) {
    throw new Error(`the in-game map was written but will not read back: ${err.message}`);
  }
  const cells = back.cells?.length ?? 0;
  if (cells !== doc.cells.length) {
    throw new Error(
      `the in-game map on disk has ${cells} cells, not the ${doc.cells.length} just written — `
        + 'something replaced it. A running Project Zomboid is the usual cause: the in-game '
        + 'builder calls WorldMap.reset(), which empties worldmap.xml.',
    );
  }
  if (doc.features === 0) {
    throw new Error('the in-game map came out with no features in it; the map screen would be blank');
  }
  log(`  map verified on disk: ${cells} cells`);
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
