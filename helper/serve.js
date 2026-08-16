#!/usr/bin/env node
/**
 * The pz-world helper.
 *
 * Project Zomboid's Lua sandbox has no HTTP client and writes text only
 * (DEV_GUIDE.md §1.6), so the network half of the mod lives here. It watches
 * `Zomboid/Lua/pzworld_request.txt`, fetches OpenStreetMap, and writes back a
 * compact text payload the mod can parse without a JSON parser.
 *
 * It deliberately stops short of deciding the world. Bearing, snapping,
 * prototype choice and rasterisation happen in Lua, in front of the player.
 * See helper/protocol.md.
 *
 *   node helper/serve.js            watch forever
 *   node helper/serve.js --once     handle one request and exit
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { findUserFolder } from '../src/lib/pzinstall.js';
import { fetchArea, normalise, checkRadius } from '../src/sources/osm.js';
import { bboxAround, Projection } from '../src/geo/project.js';
import { classifyRoad, loadRoadProfile } from '../src/plan/roads.js';
import { classifyFromTags } from '../src/plan/buildings.js';
import { groundPixelFor, polygonArea } from '../src/plan/zones.js';
import { parseWorldMapXml, encodeWorldMapBin } from '../src/formats/worldmap.js';
import { MAP_NAME, MOD_ID, CANVAS_CELLS } from '../tools/make-canvas.js';

const REQUEST = 'pzworld_request.txt';
const STATUS = 'pzworld_status.txt';
const DATA = 'pzworld_data.txt';
const BUILD = 'pzworld_build.txt';
const PROGRESS = 'pzworld_progress.txt';

/** getFileWriter/getFileReader resolve relative to Zomboid/Lua, not Zomboid. */
export function exchangeDir(userFolder = findUserFolder()) {
  const dir = path.join(userFolder, 'Lua');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readRequest(file) {
  const text = fs.readFileSync(file, 'utf8');
  // The mod terminates the file with `end`; without it the write is still in
  // flight and reading now would give a truncated request.
  if (!/^end\s*$/m.test(text)) return null;
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\w+)\s+(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeStatus(dir, stage, progress, message) {
  const body = [
    'version 1',
    `stage ${stage}`,
    `progress ${progress.toFixed(3)}`,
    `message ${message}`,
    'end',
    '',
  ].join('\n');
  // The status file is five short lines and is rewritten several times a
  // second. Renaming it is not worth the risk described in atomicWrite: the mod
  // tolerates a torn status (it re-reads next frame) and cannot tolerate the
  // helper reporting `EPERM ... rename pzworld_status.txt.tmp` as the reason
  // the build failed, which is what it did.
  writeDirect(path.join(dir, STATUS), body);
}

function writeDirect(file, body) {
  try {
    fs.writeFileSync(file, body, 'utf8');
    return true;
  } catch (err) {
    // Losing one status update is not a reason to end a download.
    process.stderr.write(`  (could not write ${path.basename(file)}: ${err.code || err.message})\n`);
    return false;
  }
}

/**
 * Write to a temporary file and rename, so the mod never reads a half-written
 * payload.
 *
 * Used for the payload only. The retry matters on Windows: the game polls these
 * files every frame, and if it happens to hold one open when the rename lands,
 * the call fails with `EPERM: operation not permitted`. Antivirus and OneDrive
 * scanners do the same thing to a file that has only just appeared. So the
 * retries back off instead of spinning for a fixed 30 ms each, and every
 * failure path ends in a plain in-place write: a torn read is recoverable
 * because the reader checks the payload's terminator, and a dead build is not.
 */
function atomicWrite(file, body) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, body, 'utf8');
  } catch {
    return writeDirect(file, body);
  }

  let renamed = false;
  for (let attempt = 0; attempt < 8 && !renamed; attempt++) {
    try {
      fs.renameSync(tmp, file);
      renamed = true;
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') break;
      // Back off: 10, 20, 40 ... ms, about a second in total.
      const until = Date.now() + 10 * 2 ** attempt;
      while (Date.now() < until) { /* spin; there is no sync sleep here */ }
    }
  }
  if (renamed) return true;

  const ok = writeDirect(file, body);
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* the temp file is harmless if it lingers */
  }
  return ok;
}

const fixed = (n) => (Math.round(n * 10) / 10).toString();

/**
 * Metres east/north of the centre, unrotated. The mod applies the world bearing
 * itself, because choosing that bearing is part of what it shows the player.
 */
function encodePoints(points, proj) {
  const out = [];
  for (const [lon, lat] of points) {
    const [e, n] = proj.toLocalMetres(lon, lat);
    out.push(`${fixed(e)},${fixed(n)}`);
  }
  return out.join(' ');
}

/** Keep anything whose bounding box touches the requested square. */
function withinRadius(points, proj, radius) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lon, lat] of points) {
    const [e, n] = proj.toLocalMetres(lon, lat);
    if (e < minX) minX = e;
    if (n < minY) minY = n;
    if (e > maxX) maxX = e;
    if (n > maxY) maxY = n;
  }
  return maxX >= -radius && minX <= radius && maxY >= -radius && minY <= radius;
}

export async function handleRequest(req, dir, { log = () => {}, cacheDir }) {
  const lat = Number(req.lat);
  const lon = Number(req.lon);
  const radius = Number(req.radius ?? 900);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('request has no lat/lon');
  checkRadius(radius);

  log(`request: ${lat}, ${lon} radius ${radius}`);
  writeStatus(dir, 'fetching', 0.05, 'Contacting OpenStreetMap');

  const bbox = bboxAround(lat, lon, radius);
  const raw = await fetchArea(bbox, { cacheDir, log });

  writeStatus(dir, 'parsing', 0.55, 'Reading map data');
  const features = normalise(raw);
  const proj = new Projection({ lat, lon, metresPerTile: 1, bearing: 0 });
  const roadProfile = loadRoadProfile();

  const lines = [];
  lines.push('version 1');
  lines.push('status ok');
  lines.push(`center ${lon} ${lat}`);
  lines.push(`radius ${radius}`);

  const roads = [];
  for (const r of features.roads) {
    const spec = classifyRoad(r, roadProfile);
    if (!spec) continue;
    if (!withinRadius(r.points, proj, radius * 1.2)) continue;
    roads.push({ spec, points: r.points });
  }

  const buildings = [];
  for (const b of features.buildings) {
    if (!withinRadius(b.points, proj, radius)) continue;
    // Area in square metres, for the size fallback when tags say nothing.
    const ring = b.points.map(([plon, plat]) => proj.toLocalMetres(plon, plat));
    const cls = classifyFromTags(b.tags, polygonArea(ring));
    buildings.push({ cls, levels: b.levels ?? 1, points: b.points });
  }

  const ground = [];
  for (const g of features.ground) {
    const pixel = groundPixelFor(g.tags);
    if (pixel === null) continue;
    if (!withinRadius(g.points, proj, radius * 1.2)) continue;
    ground.push({ pixel, points: g.points });
  }

  // Largest ground polygons first so the mod can paint them in order and let
  // smaller ones win, the same rule the offline planner uses.
  ground.sort(
    (a, b) =>
      polygonArea(b.points.map(([lo, la]) => proj.toLocalMetres(lo, la))) -
      polygonArea(a.points.map(([lo, la]) => proj.toLocalMetres(lo, la))),
  );

  lines.push(`count ${roads.length} ${buildings.length} ${ground.length}`);
  lines.push('');

  writeStatus(dir, 'encoding', 0.8, 'Preparing the world');
  for (const r of roads) {
    lines.push(`R ${r.spec.cls} ${r.spec.width} ${r.points.length}`);
    lines.push(encodePoints(r.points, proj));
  }
  for (const b of buildings) {
    lines.push(`B ${b.cls} ${b.levels} ${b.points.length}`);
    lines.push(encodePoints(b.points, proj));
  }
  for (const g of ground) {
    lines.push(`G ${g.pixel} ${g.points.length}`);
    lines.push(encodePoints(g.points, proj));
  }
  lines.push('end');
  lines.push('');

  atomicWrite(path.join(dir, DATA), lines.join('\n'));
  writeStatus(dir, 'done', 1, 'Map data ready');
  log(`wrote ${roads.length} roads, ${buildings.length} buildings, ${ground.length} areas`);
  return { roads: roads.length, buildings: buildings.length, ground: ground.length };
}

/**
 * Compile the map the mod drew into the form the game will actually read.
 *
 * The mod writes `worldmap.xml` during the build, because Lua can write text.
 * Project Zomboid does not read that file when a `.bin` exists beside it — and
 * when no `.bin` exists it reads it with `WorldMapXML`, which is broken and
 * throws out of every feature (see src/formats/worldmap.js). Lua cannot write
 * the binary either: `getModFileWriter` hands back an `OutputStreamWriter` over
 * UTF-8, so any byte above 0x7F comes out as two.
 *
 * So this is the same division of labour as the Overpass fetch — the helper is
 * the half of the mod that is allowed to touch bytes.
 *
 * Watched by modification time rather than driven by a message, so it also
 * covers the second build the server state runs during loading, and a map
 * regenerated while the game is up.
 */
export function compileMapIfChanged(state, { log = () => {}, userFolder } = {}) {
  const xmlFile = path.join(
    findUserFolder(userFolder),
    'mods',
    MOD_ID,
    'common/media/maps',
    MAP_NAME,
    'worldmap.xml',
  );

  let stat;
  try {
    stat = fs.statSync(xmlFile);
  } catch {
    return false; // no map written yet
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (state.mapStamp === stamp) return false;

  // Claim it before the work, so a build still writing the file is retried
  // rather than compiled twice.
  state.mapStamp = stamp;

  const binFile = `${xmlFile}.bin`;
  try {
    const text = fs.readFileSync(xmlFile, 'utf8');
    if (!text.includes('</world>')) {
      // Still being written; forget the stamp so the next tick tries again.
      state.mapStamp = null;
      return false;
    }
    const doc = parseWorldMapXml(text, { width: CANVAS_CELLS, height: CANVAS_CELLS });
    doc.originX = 0;
    doc.originY = 0;
    doc.width = CANVAS_CELLS;
    doc.height = CANVAS_CELLS;

    const bytes = encodeWorldMapBin(doc);
    fs.writeFileSync(binFile, bytes);
    const features = doc.cells.reduce((n, c) => n + c.features.length, 0);
    log(`compiled the map: ${features} features in ${doc.cells.length} cells, ${(bytes.length / 1e6).toFixed(2)} MB`);
    return true;
  } catch (err) {
    // A map that will not compile must not leave a stale one behind claiming to
    // be this city.
    try {
      fs.rmSync(binFile, { force: true });
    } catch {
      /* nothing useful to do */
    }
    log(`could not compile the map: ${err.message}`);
    return false;
  }
}

/**
 * Report a build's progress back to the build screen.
 *
 * The mod reads this every frame while its modal is up, so it is written whole and small.
 * `end` terminates it for the same reason the mod terminates its own files that way: the
 * reader can be part-way through a write, and a truncated read must be recognisable.
 */
function writeProgress(dir, { stage = '', progress = 0, message = '', done = false, err = '' }) {
  const body = [
    `progress ${progress.toFixed(4)}`,
    `done ${done ? 1 : 0}`,
    `error ${err}`,
    `stage ${stage}`,
    `message ${message}`,
    'end',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, PROGRESS), body, 'utf8');
}

/**
 * Run a build ordered from inside the game.
 *
 * This is the same build `npm run world` runs — the *only* build there is. It happens
 * while the player is still on the build screen at the main menu, which is the one window
 * in which it is safe: `MapFiles.load()` re-lists the map directory at world init so a
 * cell rewritten now is picked up, while `IsoLot.pool` keeps handles open once the world
 * starts streaming and on Windows rewriting an open file fails outright.
 *
 * ## Why a child process and not a function call
 *
 * The build is memory-hungry — a 2,500 m city is 33 million squares held at once — and
 * `npm run world` has always given it `--max-old-space-size=8192`. Calling it in-process
 * made the helper inherit whatever heap the helper was started with, and the first
 * in-game build died with `FATAL ERROR: Reached heap limit`, taking the helper with it
 * and leaving the player staring at a progress bar that would never move again.
 *
 * A child gets the flag whatever the helper was launched with, and a build that dies
 * kills only itself. The child writes the progress file directly, so a crash still
 * reports — the helper only ever sees an exit code.
 */
function handleBuildOrder(order, dir, { log }) {
  const script = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'tools', 'build-world.js');
  const progressFile = path.join(dir, PROGRESS);
  log(`build ordered: ${order.name || 'unnamed'} at ${order.lat}, ${order.lon}, radius ${order.radius} m`);
  writeProgress(dir, { stage: 'fetching', progress: 0.01, message: 'Starting' });

  const args = [
    '--max-old-space-size=8192',
    script,
    '--lat', String(order.lat),
    '--lon', String(order.lon),
    '--radius', String(order.radius),
    '--progress', progressFile,
  ];
  if (order.name) args.push('--name', String(order.name));
  if (order.seed) args.push('--seed', String(order.seed));

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) if (line.trim()) log(`  ${line}`);
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', (err) => {
      log(`could not start the build: ${err.message}`);
      writeProgress(dir, { stage: 'extras', done: true, message: 'Build failed', err: err.message });
      resolve(false);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        log('build finished');
        resolve(true);
        return;
      }
      log(`build exited with code ${code}`);
      // The child writes its own failure when it can. If it was killed outright — out of
      // memory, or the user closed the window — nothing was written and the screen would
      // wait for ever, so say so here.
      let reported = false;
      try {
        reported = /^done 1/m.test(fs.readFileSync(progressFile, 'utf8'));
      } catch {
        /* no progress file at all */
      }
      if (!reported) {
        writeProgress(dir, {
          stage: 'extras',
          done: true,
          message: 'Build failed',
          err: `the build stopped with exit code ${code}`,
        });
      }
      resolve(false);
    });
  });
}

export async function serve({ once = false, log = () => {}, userFolder } = {}) {
  const dir = exchangeDir(userFolder);
  const reqFile = path.join(dir, REQUEST);
  const buildFile = path.join(dir, BUILD);
  const cacheDir = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'cache');

  log(`pz-world helper watching ${dir}`);
  log('  leave this running: it is what builds the world when you press "Build this world"');
  // Clear a stale request or order so an old one is not answered on startup.
  if (fs.existsSync(reqFile)) fs.rmSync(reqFile);
  if (fs.existsSync(buildFile)) fs.writeFileSync(buildFile, '');

  const state = { mapStamp: null };
  let busy = false;
  const tick = async () => {
    if (busy) return;

    // A build order first: it is what the player is actually waiting on.
    if (fs.existsSync(buildFile)) {
      const order = readRequest(buildFile);
      if (order && Number.isFinite(Number(order.lat)) && Number.isFinite(Number(order.lon))) {
        busy = true;
        // Emptied rather than deleted, and emptied *before* the build: the mod's
        // `getFileReader` on a missing file is a different code path from an empty one,
        // and clearing first means a build that throws is not retried for ever.
        fs.writeFileSync(buildFile, '');
        try {
          await handleBuildOrder(order, dir, { log });
        } finally {
          busy = false;
          if (once) process.exit(0);
        }
        return;
      }
    }

    if (!fs.existsSync(reqFile)) {
      // Nothing to fetch, so this is the moment to notice a finished map.
      try {
        compileMapIfChanged(state, { log, userFolder });
      } catch (err) {
        log(`map watcher: ${err.message}`);
      }
      return;
    }
    const req = readRequest(reqFile);
    if (!req) return; // still being written
    busy = true;
    fs.rmSync(reqFile);
    try {
      await handleRequest(req, dir, { log, cacheDir });
    } catch (err) {
      log(`error: ${err.message}`);
      writeStatus(dir, 'error', 0, err.message);
    } finally {
      busy = false;
      if (once) process.exit(0);
    }
  };

  setInterval(tick, 400);
  await tick();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve({
    once: process.argv.includes('--once'),
    log: (m) => process.stdout.write(`${m}\n`),
  }).catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}
